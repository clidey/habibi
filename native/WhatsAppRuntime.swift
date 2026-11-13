import Foundation

// The runtime bundle is a signed container for Node, the OpenWA supervisor,
// OpenWA and Chromium. Habibi runs Contents/MacOS/node from it directly; this
// executable exists so macOS can validate, notarize and staple the component
// as a conventional app bundle. It is not launched during normal use.
FileHandle.standardError.write(Data("This component is managed by Habibi.\n".utf8))
