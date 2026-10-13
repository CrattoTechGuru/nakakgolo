plugins {
    id("com.android.application") version "8.5.2"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

android {
    namespace = "com.nakakgolo.overlay"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nakakgolo.overlay"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Serves the bundled web app from https://appassets.androidplatform.net (a secure origin,
    // so the app's login and crypto work inside the WebView).
    implementation("androidx.webkit:webkit:1.11.0")
}
