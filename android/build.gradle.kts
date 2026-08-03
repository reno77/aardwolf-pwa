// Versions are pinned to what Android Studio 2022.2 (Flamingo) accepts -- the
// version installed on this machine. AGP 8.1+ refuses to sync there ("requires
// Android Studio Hedgehog or newer"), so do not bump these without also
// upgrading Studio. AGP 8.0.x requires exactly Gradle 8.0 and JDK 17; Studio's
// bundled jbr is 17.0.6, so no separate JDK install is needed.
plugins {
    id("com.android.application") version "8.0.2" apply false
    id("org.jetbrains.kotlin.android") version "1.8.22" apply false
}
