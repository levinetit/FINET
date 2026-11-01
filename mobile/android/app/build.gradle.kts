import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "ro.finet.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Identificatorul aplicației: se fixează o singură dată (decizia operatorului, 2026-11-01).
        applicationId = "ro.finet.app"
        // Android 10 (API 29) ca minim (decizia operatorului).
        minSdk = 29
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Semnarea release: cheia operatorului, din variabile de mediu (CI: GitHub Secrets) sau din
    // `android/key.properties` (local, în afara repository-ului). Nu există cale de rezervă către
    // cheia de debug: fără cheie, build-ul release se oprește (vezi `taskGraph` mai jos).
    val keyProps = Properties().apply {
        val file = rootProject.file("key.properties")
        if (file.exists()) file.inputStream().use { load(it) }
    }
    fun signing(env: String, prop: String): String? =
        System.getenv(env)?.takeIf { it.isNotBlank() } ?: keyProps.getProperty(prop)
    val storeFilePath = signing("FINET_KEYSTORE_PATH", "storeFile")
    val storePassword = signing("FINET_KEYSTORE_PASSWORD", "storePassword")
    val keyAlias = signing("FINET_KEY_ALIAS", "keyAlias")
    val keyPassword = signing("FINET_KEY_PASSWORD", "keyPassword")
    val releaseSigningReady = listOf(storeFilePath, storePassword, keyAlias, keyPassword).all { it != null } &&
        file(storeFilePath!!).exists()

    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = file(storeFilePath!!)
                this.storePassword = storePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
            }
        }
    }

    buildTypes {
        release {
            if (releaseSigningReady) signingConfig = signingConfigs.getByName("release")
        }
    }

    // Un APK release nesemnat sau semnat cu cheia de debug nu trebuie să existe niciodată.
    gradle.taskGraph.whenReady {
        val buildsRelease = allTasks.any {
            it.project == project && it.name.contains("Release", ignoreCase = true)
        }
        if (buildsRelease && !releaseSigningReady) {
            throw GradleException(
                "Semnarea release nu e pregătită: setează FINET_KEYSTORE_PATH, " +
                    "FINET_KEYSTORE_PASSWORD, FINET_KEY_ALIAS și FINET_KEY_PASSWORD " +
                    "(sau android/key.properties). Vezi docs/FINET_ANDROID_BUILD.md.",
            )
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
