plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "dev.cade"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Community is deliberate: everything the plugin touches is platform
        // API, so it builds against the smallest thing that has it and runs in
        // every IDE in the family.
        intellijIdeaCommunity("2024.3")
        instrumentationTools()
    }
}

intellijPlatform {
    // `gradle verifyPlugin` — checks the compiled plugin against real IDEs.
    // Worth having wired up given untilBuild is deliberately unset: the claim
    // that this keeps working on next autumn's release is one a tool can check.
    pluginVerification {
        ides {
            recommended()
        }
    }

    pluginConfiguration {
        ideaVersion {
            sinceBuild = "243"
            // No upper bound. The platform API this uses has been stable for
            // years, and a pinned untilBuild is why plugins stop working on
            // the first EAP of every autumn.
            untilBuild = provider { null }
        }
    }
}

kotlin {
    jvmToolchain(21)
}

// No Firebase SDK and no HTTP library anywhere in this file. java.net.http is
// enough for one PUT, and that matters: shading the Firebase Admin SDK into an
// IDE plugin is misery for no return.
