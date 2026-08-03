# The bridge is reached by name from JavaScript, so its methods must survive
# any future shrinking pass even though nothing in Kotlin calls them.
-keepclassmembers class win.bedok77.aardclient.AardBridge {
    public *;
}
