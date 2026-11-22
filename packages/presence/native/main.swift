// agentbridge-helper: macOS platform helper for the agentbridge bridge (SPEC §9.2, §15.5).
//
// Protocol: `agentbridge-helper <subcommand>`; exactly one JSON object on stdin; exactly one JSON
// object on stdout; exit 0 whenever a well-formed response was written (even {"ok":false}), 2 on
// a usage/protocol error (the response still says why). Secret values travel only over
// stdin/stdout, never argv or env, and are never written to stderr.
//
// Subcommands:
//   presence         {"reason": String, "timeout_ms"?: Int}     -> {"ok":true} | {"ok":false,"la_code":Int,"detail":String,"stage":"can_evaluate"|"evaluate"|"timeout"}
//   keychain-get     {"account": String, "service"?: String}    -> {"ok":true,"value":String|null}
//   keychain-set     {"account": String, "value": String, "service"?: String} -> {"ok":true}
//   keychain-delete  {"account": String, "service"?: String}    -> {"ok":true,"deleted":Bool}
// Keychain service is always "agentbridge"; "service" may only name a throwaway test service
// "agentbridge.test.<suffix>", so this trusted binary cannot be used as an oracle for other items.
//   version          {}                                         -> {"ok":true,"version":String,"protocol":1}
// Errors: {"ok":false,"error":"bad_request"|"unknown_subcommand"|"keychain","detail":String,"os_status"?:Int}
// LAError -> result-code mapping lives in the Node wrapper (src/protocol.ts), not here.
import Foundation
import LocalAuthentication
import Security

let helperVersion = "0.1.0"
let maxStdinBytes = 1 << 20  // 1 MiB; requests are tiny

func emit(_ obj: [String: Any], exitCode: Int32 = 0) -> Never {
  // JSONSerialization escapes everything needed; sortedKeys keeps output deterministic for tests.
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]))
    ?? Data("{\"ok\":false,\"error\":\"internal\",\"detail\":\"encode failed\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(exitCode)
}

func fail(_ error: String, _ detail: String, status: OSStatus? = nil, exitCode: Int32 = 0) -> Never {
  var o: [String: Any] = ["ok": false, "error": error, "detail": detail]
  if let s = status { o["os_status"] = Int(s) }
  emit(o, exitCode: exitCode)
}

func readRequest() -> [String: Any] {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  if data.count > maxStdinBytes { fail("bad_request", "request too large", exitCode: 2) }
  if data.isEmpty { return [:] }
  guard let obj = try? JSONSerialization.jsonObject(with: data), let dict = obj as? [String: Any] else {
    fail("bad_request", "stdin is not a JSON object", exitCode: 2)
  }
  return dict
}

func str(_ req: [String: Any], _ key: String, allowEmpty: Bool = false) -> String {
  guard let v = req[key] as? String, allowEmpty || !v.isEmpty else {
    fail("bad_request", "missing or invalid string field: \(key)", exitCode: 2)
  }
  return v
}

func secMessage(_ status: OSStatus) -> String {
  (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
}

// MARK: presence

let defaultPresenceTimeoutMs = 120_000
let maxPresenceTimeoutMs = 600_000

func presence(_ req: [String: Any]) -> Never {
  let reason = str(req, "reason")
  var timeoutMs = defaultPresenceTimeoutMs
  if let t = req["timeout_ms"] {
    guard let n = t as? Int, n >= 1, n <= maxPresenceTimeoutMs else {
      fail("bad_request", "timeout_ms must be an integer in 1...\(maxPresenceTimeoutMs)", exitCode: 2)
    }
    timeoutMs = n
  }
  let ctx = LAContext()
  let policy = LAPolicy.deviceOwnerAuthentication  // Touch ID, falling back to the account password
  var canErr: NSError?
  if !ctx.canEvaluatePolicy(policy, error: &canErr) {
    emit(["ok": false, "stage": "can_evaluate", "la_code": canErr?.code ?? 0,
          "detail": canErr?.localizedDescription ?? "cannot evaluate policy"])
  }
  let sem = DispatchSemaphore(value: 0)
  var success = false
  var evalErr: NSError?
  ctx.evaluatePolicy(policy, localizedReason: reason) { ok, err in
    success = ok
    evalErr = err as NSError?
    sem.signal()
  }
  if sem.wait(timeout: .now() + .milliseconds(timeoutMs)) == .timedOut {
    // Dismiss the dialog ourselves, then give LocalAuthentication a moment to call back.
    ctx.invalidate()
    _ = sem.wait(timeout: .now() + .seconds(2))
    emit(["ok": false, "stage": "timeout", "la_code": LAError.Code.appCancel.rawValue,
          "detail": "no response within \(timeoutMs) ms"])
  }
  if success { emit(["ok": true]) }
  emit(["ok": false, "stage": "evaluate", "la_code": evalErr?.code ?? 0,
        "detail": evalErr?.localizedDescription ?? "authentication did not succeed"])
}

// MARK: keychain (generic passwords, legacy file-based login keychain)

let productionService = "agentbridge"

func service(_ req: [String: Any]) -> String {
  guard let raw = req["service"] else { return productionService }
  guard let s = raw as? String else { fail("bad_request", "service must be a string", exitCode: 2) }
  if s == productionService { return s }
  let prefix = "agentbridge.test."
  let suffix = s.hasPrefix(prefix) ? String(s.dropFirst(prefix.count)) : ""
  let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-")
  guard !suffix.isEmpty, suffix.count <= 64, suffix.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
    fail("bad_request", "service must be \"agentbridge\" or \"agentbridge.test.<suffix>\"", exitCode: 2)
  }
  return s
}

func baseQuery(_ req: [String: Any]) -> [String: Any] {
  [kSecClass as String: kSecClassGenericPassword,
   kSecAttrService as String: service(req),
   kSecAttrAccount as String: str(req, "account")]
}

func keychainGet(_ req: [String: Any]) -> Never {
  var q = baseQuery(req)
  q[kSecReturnData as String] = true
  q[kSecMatchLimit as String] = kSecMatchLimitOne
  var out: CFTypeRef?
  let status = SecItemCopyMatching(q as CFDictionary, &out)
  if status == errSecItemNotFound { emit(["ok": true, "value": NSNull()]) }
  guard status == errSecSuccess else { fail("keychain", secMessage(status), status: status) }
  guard let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
    fail("keychain", "stored item is not valid UTF-8")
  }
  emit(["ok": true, "value": value])
}

// Always delete-then-add (never SecItemUpdate): the item gets a fresh ACL naming this helper and
// fresh attributes, and an item pre-created by another process (with an ACL trusting itself)
// cannot capture the new secret. Not atomic: a crash between the two calls loses the old value,
// which callers treat like "secret missing".
func keychainSet(_ req: [String: Any]) -> Never {
  let q = baseQuery(req)
  let data = Data(str(req, "value", allowEmpty: true).utf8)
  let del = SecItemDelete(q as CFDictionary)
  guard del == errSecSuccess || del == errSecItemNotFound else { fail("keychain", secMessage(del), status: del) }
  var add = q
  add[kSecValueData as String] = data
  // Recorded for a later move to the data-protection keychain; the legacy file-based login
  // keychain does not enforce it (see README "Keychain items").
  add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
  add[kSecAttrLabel as String] = "agentbridge: \(str(req, "account"))"
  let status = SecItemAdd(add as CFDictionary, nil)
  guard status == errSecSuccess else { fail("keychain", secMessage(status), status: status) }
  emit(["ok": true])
}

func keychainDelete(_ req: [String: Any]) -> Never {
  let status = SecItemDelete(baseQuery(req) as CFDictionary)
  if status == errSecItemNotFound { emit(["ok": true, "deleted": false]) }
  guard status == errSecSuccess else { fail("keychain", secMessage(status), status: status) }
  emit(["ok": true, "deleted": true])
}

// MARK: main

let args = CommandLine.arguments
guard args.count == 2 else { fail("bad_request", "usage: agentbridge-helper <subcommand> < request.json", exitCode: 2) }
let sub = args[1]
let known = ["presence", "keychain-get", "keychain-set", "keychain-delete", "version"]
guard known.contains(sub) else { fail("unknown_subcommand", "unknown subcommand: \(sub)", exitCode: 2) }
let req = readRequest()
switch sub {
case "presence": presence(req)
case "keychain-get": keychainGet(req)
case "keychain-set": keychainSet(req)
case "keychain-delete": keychainDelete(req)
default: emit(["ok": true, "version": helperVersion, "protocol": 1])
}
