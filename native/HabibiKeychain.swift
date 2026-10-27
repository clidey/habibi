import Foundation
import Security

// Use raw stdin bytes: the security CLI's password prompt truncates long OIDC sessions.
func fail() -> Never {
  FileHandle.standardError.write(Data("Habibi Keychain operation failed.\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 3 else { fail() }
let action = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let modelKey = ["get-model-key", "set-model-key", "delete-model-key"].contains(action)
let operation = modelKey ? action.replacingOccurrences(of: "-model-key", with: "") : action
guard !account.isEmpty, account.utf8.count <= 2048 else { fail() }
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: modelKey ? "Habibi LLM Provider" : "Habibi WhoDB",
  kSecAttrAccount as String: account,
]

switch operation {
case "get":
  var request = query
  request[kSecReturnData as String] = true
  request[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?
  guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
        let value = result as? Data else { fail() }
  FileHandle.standardOutput.write(value)
case "set":
  let value = FileHandle.standardInput.readDataToEndOfFile()
  guard !value.isEmpty, value.count <= 262144 else { fail() }
  if modelKey {
    guard let key = String(data: value, encoding: .utf8),
          key.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { fail() }
  } else if (try? JSONSerialization.jsonObject(with: value)) == nil { fail() }
  let changes = [kSecValueData as String: value]
  let status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
  if status == errSecItemNotFound {
    guard SecItemAdd(query.merging(changes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil) == errSecSuccess else { fail() }
  } else if status != errSecSuccess { fail() }
case "delete":
  let status = SecItemDelete(query as CFDictionary)
  guard status == errSecSuccess || status == errSecItemNotFound else { fail() }
default:
  fail()
}
