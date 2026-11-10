import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('android');
const javaRoot = path.join(root, 'app', 'src', 'main', 'java');
const nativeSource = path.resolve('native', 'EdenDeviceKeyPlugin.java');
const testSource = path.resolve('native-test', 'EdenFoundationInstrumentedTest.java');

function findFile(directory, filename) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(candidate, filename);
      if (found) return found;
    } else if (entry.isFile() && entry.name === filename) return candidate;
  }
  return null;
}

const mainActivity = findFile(javaRoot, 'MainActivity.java');
if (!mainActivity) throw new Error('Capacitor MainActivity.java was not generated.');
const source = fs.readFileSync(mainActivity, 'utf8');
const packageMatch = source.match(/^package\s+([\w.]+);/m);
if (!packageMatch) throw new Error('Unable to determine Android application package.');
const packageName = packageMatch[1];
const packageDirectory = path.join(javaRoot, ...packageName.split('.'));
fs.mkdirSync(packageDirectory, { recursive: true });

const plugin = fs.readFileSync(nativeSource, 'utf8').replace(/^package\s+[\w.]+;/m, `package ${packageName};`);
fs.writeFileSync(path.join(packageDirectory, 'EdenDeviceKeyPlugin.java'), plugin);

let activity = source;
if (!activity.includes('EdenDeviceKeyPlugin.class')) {
  activity = activity.replace(
    /public class MainActivity extends BridgeActivity\s*\{/,
    `public class MainActivity extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(EdenDeviceKeyPlugin.class);\n        super.onCreate(savedInstanceState);\n    }\n`,
  );
  activity = activity.replace(/import com.getcapacitor.BridgeActivity;/, 'import com.getcapacitor.BridgeActivity;\nimport ' + packageName + '.EdenDeviceKeyPlugin;');
  fs.writeFileSync(mainActivity, activity);
}

const manifestPath = path.join(root, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
// Do not lock orientation: Android 16 ignores orientation restrictions on large screens.
manifest = manifest.replace(/(<activity\b[^>]*?)\s+android:screenOrientation="[^"]*"/s, '$1');
manifest = manifest.replace(/(<activity\b[^>]*android:name="[^"]*MainActivity"[^>]*)(>)/s, (all, before, close) =>
  before.includes('android:resizeableActivity') ? all : before + ' android:resizeableActivity="true"' + close);
manifest = manifest.replace(/(<application\b[^>]*)(>)/s, (all, before, close) => {
  let updated = before;
  if (!updated.includes('android:allowBackup')) updated += ' android:allowBackup="false"';
  if (!updated.includes('android:dataExtractionRules')) updated += ' android:dataExtractionRules="@xml/data_extraction_rules"';
  return updated + close;
});
fs.writeFileSync(manifestPath, manifest);

// Pin the Android 16 SDK contract explicitly for Capacitor 8.x.
const variablesPath = path.join(root, 'variables.gradle');
if (!fs.existsSync(variablesPath)) throw new Error('Capacitor variables.gradle was not generated.');
let variables = fs.readFileSync(variablesPath, 'utf8');
for (const setting of ['compileSdkVersion', 'targetSdkVersion']) {
  const pattern = new RegExp('(' + setting + '\\s*=\\s*)\\d+');
  if (!pattern.test(variables)) throw new Error('Missing ' + setting + ' in variables.gradle.');
  variables = variables.replace(pattern, (_match, prefix) => prefix + '36');
}
fs.writeFileSync(variablesPath, variables);

const xmlDirectory = path.join(root, 'app', 'src', 'main', 'res', 'xml');
fs.mkdirSync(xmlDirectory, { recursive: true });
fs.writeFileSync(path.join(xmlDirectory, 'data_extraction_rules.xml'), `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" /><exclude domain="database" /><exclude domain="sharedpref" /><exclude domain="external" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" /><exclude domain="database" /><exclude domain="sharedpref" /><exclude domain="external" />
    </device-transfer>
</data-extraction-rules>
`);

const gradlePath = path.join(root, 'app', 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
if (!gradle.includes('testInstrumentationRunner')) {
  gradle = gradle.replace(/defaultConfig\s*\{/, 'defaultConfig {\n        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"');
}
if (!gradle.includes('androidx.test:runner')) {
  gradle = gradle.replace(/dependencies\s*\{/, 'dependencies {\n    androidTestImplementation "androidx.test:runner:1.6.2"\n    androidTestImplementation "androidx.test:rules:1.6.1"\n    androidTestImplementation "androidx.test.ext:junit:1.2.1"');
}
fs.writeFileSync(gradlePath, gradle);

const generatedTestRoot = path.join(root, 'app', 'src', 'androidTest');
const generatedExampleTest = findFile(generatedTestRoot, 'ExampleInstrumentedTest.java');
if (generatedExampleTest) fs.unlinkSync(generatedExampleTest);

const testRoot = path.join(root, 'app', 'src', 'androidTest', 'java');
const testPackageDir = path.join(testRoot, ...packageName.split('.'));
fs.mkdirSync(testPackageDir, { recursive: true });
const test = fs.readFileSync(testSource, 'utf8').replace(/^package\s+[\w.]+;/m, `package ${packageName};`);
fs.writeFileSync(path.join(testPackageDir, 'EdenFoundationInstrumentedTest.java'), test);

console.log('Registered native ES256 plugin, Android instrumentation tests, adaptive orientation, API 36 SDK and backup protections.');
