package corp.edendevs.edengestion.android;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;

import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class EdenFoundationInstrumentedTest {
    private static final String ALIAS = "corp.edendevs.edengestion.device.es256.v1";

    @Test
    public void mainActivityDoesNotLockOrientationForAdaptiveLargeScreens() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ActivityInfo activity = context.getPackageManager().getActivityInfo(
            new ComponentName(context, MainActivity.class),
            android.content.pm.PackageManager.GET_META_DATA
        );
        assertEquals("Android 16 large-screen layouts must remain orientation-adaptive",
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.screenOrientation);
    }

    @Test
    public void sqlCipherNativeLibraryLoadsOnCurrentPageSizeRuntime() {
        // The 16 KB API 35 matrix leg executes this same test on a 16 KB system image.
        // A misaligned or incompatible SQLCipher .so fails here during native loading.
        System.loadLibrary("sqlcipher");
    }

    @Test
    public void sqliteRowSurvivesCloseAndReopen() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SQLiteDatabase db = context.openOrCreateDatabase("eden-foundation-test.db", Context.MODE_PRIVATE, null);
        db.execSQL("CREATE TABLE IF NOT EXISTS persistence_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        db.execSQL("INSERT OR REPLACE INTO persistence_probe(id, value) VALUES(1, 'survives-reopen')");
        db.close();

        SQLiteDatabase reopened = context.openOrCreateDatabase("eden-foundation-test.db", Context.MODE_PRIVATE, null);
        try (Cursor cursor = reopened.rawQuery("SELECT value FROM persistence_probe WHERE id=1", null)) {
            assertTrue("Expected persisted SQLite row", cursor.moveToFirst());
            assertEquals("survives-reopen", cursor.getString(0));
        } finally {
            reopened.close();
            context.deleteDatabase("eden-foundation-test.db");
        }
    }

    @Test
    public void androidKeystoreKeySignsAndVerifiesAfterKeystoreReload() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build());
            generator.generateKeyPair();
        }

        ECPublicKey original = (ECPublicKey) store.getCertificate(ALIAS).getPublicKey();
        byte[] message = "eden-keystore-persistence".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign((java.security.PrivateKey) store.getKey(ALIAS, null));
        signer.update(message);
        byte[] signature = signer.sign();

        store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        ECPublicKey reloaded = (ECPublicKey) store.getCertificate(ALIAS).getPublicKey();
        assertArrayEquals(original.getEncoded(), reloaded.getEncoded());
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(reloaded);
        verifier.update(message);
        assertTrue("Signature from reloaded Android Keystore key must verify", verifier.verify(signature));
        assertEquals("P-256 curve field size", 256, reloaded.getParams().getCurve().getField().getFieldSize());
    }
}
