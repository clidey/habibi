import Foundation

// The runtime bundle is a signed container for OpenWA and Chromium. Habibi
// starts its JavaScript entry point with the Node binary in the main app; this
// executable exists so macOS can validate, notarize and staple the component as
// a conventional app bundle. It is not launched during normal use.
FileHandle.standardError.write(Data("This component is managed by Habibi.\n".utf8))
