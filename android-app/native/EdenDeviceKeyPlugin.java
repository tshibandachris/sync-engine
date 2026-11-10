package corp.edendevs.edengestion.android;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

@CapacitorPlugin(name = "EdenDeviceKey")
public class EdenDeviceKeyPlugin extends Plugin {
    private static final String KEY_ALIAS = "corp.edendevs.edengestion.device.es256.v1";
    private static final int P256_BYTES = 32;

    @PluginMethod
    public void getOrCreateKey(PluginCall call) {
        try {
            KeyStore keyStore = loadKeyStore();
            if (!keyStore.containsAlias(KEY_ALIAS)) {
                KeyPairGenerator generator = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore"
                );
                KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
                )
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build();
                generator.initialize(spec);
                generator.generateKeyPair();
            }

            Certificate certificate = keyStore.getCertificate(KEY_ALIAS);
            if (certificate == null || !(certificate.getPublicKey() instanceof ECPublicKey)) {
                throw new IllegalStateException("Android Keystore certificate is missing or not EC.");
            }
            ECPublicKey publicKey = (ECPublicKey) certificate.getPublicKey();
            JSObject result = new JSObject();
            result.put("publicKeyPem", toPem(publicKey.getEncoded()));
            result.put("algorithm", "ES256");
            result.put("curve", "P-256");
            result.put("keyAlias", KEY_ALIAS);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to create or load the Android Keystore ES256 key.", error);
        }
    }

    @PluginMethod
    public void sign(PluginCall call) {
        try {
            String encoded = call.getString("dataBase64Url");
            if (encoded == null || encoded.isEmpty() || encoded.length() > 16384) {
                call.reject("A bounded base64url signing input is required.");
                return;
            }
            byte[] message = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            KeyStore keyStore = loadKeyStore();
            if (!keyStore.containsAlias(KEY_ALIAS)) {
                call.reject("Device ES256 key has not been created.");
                return;
            }
            PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEY_ALIAS, null);
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(privateKey);
            signer.update(message);
            byte[] derSignature = signer.sign();
            byte[] p1363 = derToP1363(derSignature);
            JSObject result = new JSObject();
            result.put("signatureBase64Url", Base64.encodeToString(
                p1363, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP
            ));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Android Keystore ES256 signing failed.", error);
        }
    }

    private static KeyStore loadKeyStore() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        return keyStore;
    }

    private static String toPem(byte[] encoded) {
        String base64 = Base64.encodeToString(encoded, Base64.NO_WRAP);
        StringBuilder pem = new StringBuilder("-----BEGIN PUBLIC KEY-----\n");
        for (int i = 0; i < base64.length(); i += 64) {
            pem.append(base64, i, Math.min(i + 64, base64.length())).append('\n');
        }
        return pem.append("-----END PUBLIC KEY-----\n").toString();
    }

    // Android's SHA256withECDSA emits ASN.1 DER; the server's ES256 JWS
    // contract requires the fixed-width IEEE P1363 r || s representation.
    private static byte[] derToP1363(byte[] der) throws Exception {
        if (der.length < 8 || der[0] != 0x30) throw new IllegalArgumentException("Invalid ECDSA DER sequence.");
        int[] cursor = new int[] { 1 };
        int sequenceLength = readLength(der, cursor);
        if (sequenceLength != der.length - cursor[0]) throw new IllegalArgumentException("Invalid ECDSA sequence length.");
        byte[] r = readInteger(der, cursor);
        byte[] s = readInteger(der, cursor);
        if (cursor[0] != der.length) throw new IllegalArgumentException("Unexpected ECDSA DER data.");
        byte[] result = new byte[P256_BYTES * 2];
        copyScalar(r, result, 0);
        copyScalar(s, result, P256_BYTES);
        return result;
    }

    private static int readLength(byte[] der, int[] cursor) {
        int first = der[cursor[0]++] & 0xff;
        if (first < 0x80) return first;
        int count = first & 0x7f;
        if (count < 1 || count > 2 || cursor[0] + count > der.length) {
            throw new IllegalArgumentException("Unsupported ECDSA DER length.");
        }
        int length = 0;
        for (int i = 0; i < count; i++) length = (length << 8) | (der[cursor[0]++] & 0xff);
        return length;
    }

    private static byte[] readInteger(byte[] der, int[] cursor) {
        if (cursor[0] >= der.length || der[cursor[0]++] != 0x02) {
            throw new IllegalArgumentException("ECDSA scalar integer expected.");
        }
        int length = readLength(der, cursor);
        if (length < 1 || cursor[0] + length > der.length) throw new IllegalArgumentException("Invalid ECDSA scalar.");
        byte[] value = new byte[length];
        System.arraycopy(der, cursor[0], value, 0, length);
        cursor[0] += length;
        return value;
    }

    private static void copyScalar(byte[] scalar, byte[] target, int offset) {
        int start = 0;
        while (start < scalar.length - 1 && scalar[start] == 0) start++;
        int length = scalar.length - start;
        if (length > P256_BYTES) throw new IllegalArgumentException("ECDSA scalar exceeds P-256 width.");
        System.arraycopy(scalar, start, target, offset + P256_BYTES - length, length);
    }
}
