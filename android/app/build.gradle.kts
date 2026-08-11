plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "win.bedok77.aardclient"
    compileSdk = 33

    defaultConfig {
        applicationId = "win.bedok77.aardclient"
        minSdk = 26          // adaptive icons, no legacy mipmap fallback needed
        targetSdk = 33
        // Bump on every build you hand to a device, or Android silently keeps the
        // installed one and you debug a fix that is not there.
        versionCode = 19
        versionName = "2.8"
    }

    // The web client is NOT copied into the app -- the app compiles the live
    // pwa/ directory straight in as assets. One source of truth: fixing snd.js
    // fixes the browser client and the next app build together, and there is no
    // stale duplicate to forget about.
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", rootProject.file("../pwa"))
        }
    }

    androidResources {
        // gaardian_maps.db is 3.4MB and sql-wasm.wasm 600KB. Both are read
        // through AssetManager; leaving them uncompressed costs APK size but
        // makes them memory-mappable and sidesteps the historic size limits on
        // compressed assets.
        noCompress.addAll(listOf("db", "wasm"))
    }

    buildFeatures {
        // AGP 8 stopped generating BuildConfig by default; MainActivity reads
        // BuildConfig.DEBUG to decide whether to enable chrome://inspect.
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false      // the logic lives in JS; nothing to shrink
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            // org.json ships as a signature-only stub in android.jar, so calling
            // it from a JVM test throws "not mocked". The real implementation is
            // added as a test dependency below; this keeps any other unstubbed
            // framework call from failing the run.
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.10.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    // WebViewAssetLoader: serves the assets over an https origin instead of
    // file://, which is what makes IndexedDB, localStorage and ES modules work.
    implementation("androidx.webkit:webkit:1.7.0")

    testImplementation("junit:junit:4.13.2")
    // A real org.json for unit tests; the one in android.jar is a stub.
    testImplementation("org.json:json:20231013")
}
