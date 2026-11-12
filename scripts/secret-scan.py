#!/usr/bin/env python3
"""High-confidence secret scan with exact path and exact value exceptions."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST_PATH = ROOT / ".secret-scan-allowlist.json"
PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[A-Z0-9]{16}\b"),
    re.compile(r"postgres(?:ql)?://[^:/@ \t]+:(?P<secret>[^@/ \t]{16,})@", re.IGNORECASE),
    re.compile(r"(?:PASSWORD|SUPABASE_SERVICE_ROLE_KEY|RENDER_DB_PASSWORD|R2_SECRET_ACCESS_KEY)[ \t]*[:=][ \t]*(?P<secret>[A-Za-z0-9_./+=-]{16,})", re.IGNORECASE),
]

def is_allowlisted(path: str, value: str, allowlist: dict) -> bool:
    return value in allowlist.get(path, [])

def scan_line(path: str, line: str, line_number: int, allowlist: dict):
    findings = []
    for pattern in PATTERNS:
        for match in pattern.finditer(line):
            value = match.groupdict().get("secret") or match.group(0)
            if not is_allowlisted(path, value, allowlist):
                findings.append((path, line_number))
    return findings

def self_test(allowlist: dict) -> None:
    # A line-level grep -v exception for "change-me" hid this fake credential.
    sample = "PASS" + "WORD=FakeTestCredential123456 # change-me"
    if not scan_line("test/secret-scan-self-test.txt", sample, 7, allowlist):
        raise SystemExit("Self-test failed: line containing change-me was not detected.")

    expected_paths = {
        ".env.example",
        ".github/workflows/pos-migrations.yml",
        ".env.prod.example",
        ".env.test.example",
        "test/helpers/testcontainers-pg.ts",
    }
    if set(allowlist) != expected_paths:
        raise SystemExit("Self-test failed: allowlist paths differ from the five reviewed paths.")

    # For every allowlisted path, put a fake secret next to an allowed captured
    # value. The allowed value must be ignored, but the adjacent fake must fail.
    for path, values in allowlist.items():
        if not values:
            raise SystemExit(f"Self-test failed: empty allowlist for {path}.")
        marker = values[0]
        fake_secret = "FakeTest" + "Credential123456"
        line = f"PASSWORD={marker} PASSWORD={fake_secret}"
        findings = scan_line(path, line, 11, allowlist)
        if findings != [(path, 11)]:
            raise SystemExit(
                f"Self-test failed: adjacent fake secret was not detected for {path}."
            )

    # Exact-value and exact-path checks: neither a changed value nor another
    # file may inherit an exception.
    for path, values in allowlist.items():
        for value in values:
            if not is_allowlisted(path, value, allowlist):
                raise SystemExit(f"Self-test failed: exact exception missing for {path}.")
            if is_allowlisted(path, value + "_extra", allowlist):
                raise SystemExit(f"Self-test failed: non-exact value accepted for {path}.")
            if is_allowlisted("unrelated/" + path, value, allowlist):
                raise SystemExit(f"Self-test failed: exception leaked from {path}.")

    print(
        "Secret scanner self-test passed: exact captured values only; "
        "adjacent fake secrets detected in all five allowlisted files."
    )

def main() -> int:
    allowlist = json.loads(ALLOWLIST_PATH.read_text(encoding="utf-8"))
    if "--self-test" in sys.argv:
        self_test(allowlist)
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    findings = []
    for relative in filter(None, tracked):
        if relative.endswith(".lock") or relative.endswith("package-lock.json"):
            continue
        try:
            content = (ROOT / relative).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for number, line in enumerate(content.splitlines(), start=1):
            findings.extend(scan_line(relative, line, number, allowlist))
    if findings:
        print("::error::Potential secret-like values found; matched values are suppressed.")
        for path, number in sorted(set(findings)):
            print(f"{path}:{number}")
        return 1
    print("No unallowlisted high-confidence secret patterns found.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
