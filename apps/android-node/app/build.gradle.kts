plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.affankhan.atlas.node"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.affankhan.atlas.node"
        minSdk = 26
        targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        versionCode = providers.gradleProperty("atlasMobileVersionCode").get().toInt()
        versionName = providers.gradleProperty("atlasMobileVersionName").get()
        // Public Firebase app identifiers supplied only for configured Android builds.
        // CI deliberately builds without Firebase service credentials.
        val fcmFields = mapOf(
            "ATLAS_FCM_APP_ID" to "atlasFirebaseAppId",
            "ATLAS_FCM_SENDER_ID" to "atlasFirebaseSenderId",
            "ATLAS_FCM_API_KEY" to "atlasFirebaseApiKey",
            "ATLAS_FCM_PROJECT_ID" to "atlasFirebaseProjectId",
        )
        fcmFields.forEach { (field, prop) ->
            val value = providers.gradleProperty(prop).orNull ?: ""
            require(value.matches(Regex("[A-Za-z0-9:_-]{0,160}"))) {
                "Invalid Firebase client configuration property: $prop"
            }
            buildConfigField("String",field,"\"$value\"")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
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
    implementation(platform("androidx.compose:compose-bom:2025.03.00"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(platform("com.google.firebase:firebase-bom:33.13.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.03.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
