// The IntelliJ Platform Gradle Plugin comes from the plugin portal, and the
// portal has to be declared before build.gradle.kts's plugins block runs — so
// it lives here. Repository declarations for DEPENDENCIES stay in
// build.gradle.kts; centralising them here as well needs the settings variant
// of the plugin and buys nothing in a single-module build.
pluginManagement {
    repositories {
        gradlePluginPortal()
    }
}

rootProject.name = "cade-ide-tracker"
