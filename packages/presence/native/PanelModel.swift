// Agent panel view model (TODO item 14, step A): one pure step from an `agentbridge status --json` snapshot
// (docs/status-json.md, schema 1) to what the menu-bar dropdown draws. Foundation only, no AppKit or SwiftUI, so
// `AgentBridge panel --print-model < snapshot.json` can print it as JSON for tests without starting any UI.
//
// Read-only by design: nothing here approves, declines or opens a transcript. A waiting approval says where to answer
// (`answer_in`) and offers to copy that address (or the `agentbridge approve <id>` command when the session can't
// show prompts); approving stays in the agent's own prompt or behind Touch ID in the CLI.
import Foundation

/// The schema this panel understands. A higher one means the CLI is newer than this panel: show "update agentbridge".
let panelSchema = 1

// MARK: input (tolerant: every field optional, unknown fields and enum values ignored)

struct SnapHead: Decodable { let schema: Int?; let kind: String?; let generated_at: String? }

struct Snapshot: Decodable {
  struct Bridge: Decodable {
    struct Policy: Decodable { let ok: Bool?; let version: Int?; let mode: String?; let reason: String? }
    struct Relay: Decodable { let state: String?; let mode: String? }
    let running: Bool?; let error: String?; let version: String?; let cli_version: String?
    let version_mismatch: String?; let complete: Bool?; let policy: Policy?; let relay: Relay?
  }
  struct Warning: Decodable { let code: String?; let text: String?; let agents: [String]? }
  struct Need: Decodable {
    let type: String?
    // approval
    let approval_id: String?; let kind: String?; let from: String?; let to: String?; let topic: String?
    let turn_limit: Int?; let expires_at: String?; let answer_in: String?; let answer_with: String?
    let conversation_id: String?
    // held_messages
    let agent: String?; let hold: String?; let count: Int?; let text: String?
  }
  struct Project: Decodable { let key: String; let label: String }
  struct Agent: Decodable {
    let address: String; let app: String?; let name: String?; let title: String?; let mode: String?
    let state: String?; let activity: String?; let project: Project?
  }
  struct Conversation: Decodable {
    struct Turns: Decodable { let used: Int?; let limit: Int? }
    struct Approval: Decodable { let kind: String?; let via: String?; let agent: String?; let at: String?; let turn_limit: Int? }
    let id: String; let from: String; let to: String; let topic: String?; let state: String?; let end_reason: String?
    /// One entry per turn, no text (optional: a bridge that doesn't send it gets the aggregated sequence view).
    struct TurnEntry: Decodable { let turn: Int?; let from: String?; let at: String? }
    let turns: Turns?; let queued: Bool?; let started_at: String?; let ended_at: String?; let last_activity_at: String?
    let approvals: [Approval]?; let turn_log: [TurnEntry]?
  }
  let schema: Int?; let generated_at: String?
  let bridge: Bridge?; let warnings: [Warning]?; let needs_you: [Need]?
  let agents: [Agent]?; let closed_agents: Int?; let conversations: [Conversation]?
}

// MARK: output

enum AgentState: String, Encodable { case talking, needsYou = "needs_you", working, idle, closed }

struct AgentRow: Encodable, Identifiable {
  var id: String { address }
  let address: String
  let app: String
  let badge: String
  let name: String
  let title: String?
  let project: String?
  let state: AgentState
  /// Short tag drawn at the end of the row ("talking", "invited", "more turns?", "1st prompt", "unreachable", "closed", …); nil for plain idle.
  let tag: String?
}

struct StateBar: Encodable, Equatable {
  var talking = 0, needs_you = 0, working = 0, idle = 0, closed = 0
  var total: Int { talking + needs_you + working + idle + closed }
  var active: Int { talking + needs_you + working }
}

struct AgentGroup: Encodable, Identifiable {
  let id: String          // "project:<key>", "project:none", "app:<app>"
  let label: String
  let count: Int
  let bar: StateBar
  /// Idle groups (nobody talking, working or waiting on you) start collapsed.
  let collapsed: Bool
  /// Talking, needs-you and working agents first, then idle, then closed; address order within each.
  let agents: [AgentRow]
}

/// One "Needs you" line: where to act ("Answer in codex:trailmap"), a short meta ("7 min", "1 held") and a copy button.
struct NeedRow: Encodable, Identifiable {
  let id: String
  let kind: String          // "approval" | "held"
  let verb: String          // "Answer in" | "Type in" | "Run agentbridge approve for"
  let target: String        // display name of the agent to act in
  let app: String           // that agent's app ("claude", "codex", …): its icon goes before the name
  let meta: String          // "7 min" | "1 held" | "waiting for the session"
  /// The short grey second line: what it's about (“topic” · from whom | more turns | why messages wait).
  let context: String
  let detail: String        // tooltip: who asks whom, topic, turns | the bridge's own sentence
  let copyLabel: String     // accessibility label: "Copy address …" | "Copy command …"
  let copy: String          // what the copy button puts on the clipboard
  let expiresAt: String?
  enum CodingKeys: String, CodingKey { case id, kind, verb, target, app, meta, context, detail, copyLabel = "copy_label", copy, expiresAt = "expires_at" }
}

let holdReasons: [String: String] = [
  "unknown_mode": "waiting for its first prompt", "closed": "the session is closed", "unreachable": "the session can't receive yet",
  "policy": "held by your policy", "serialized": "queued behind another delivery", "cap": "over the delivery cap",
  "retry": "retrying delivery", "invite_wait": "waiting for the invitation to be accepted",
]

/// One conversation: topic first, then the agent pair in grey; a ✓ (a human approved) or "rule" (an allow rule did),
/// whose tooltip lists every approval: who, how, when.
struct ConversationRow: Encodable, Identifiable {
  let id: String
  let topic: String
  let pair: String          // "harbor feat/billing ↔ grok:researcher"
  let live: Bool
  let pending: Bool
  let turns: String         // "6/30"
  let mark: String          // "✓" | "rule" | ""
  /// One line per approval ("Started: you, in harbor's prompt · 14:07"); the mark's tooltip.
  let approvals: [String]
  let ended: String?        // "13:52 · turn limit"
  // for the graph window (step B): who, and the B3 sequence (approvals and turns over time, never message text)
  let from: String
  let to: String
  let lastActivityAt: String?
  let sequence: [SeqEvent]
  /// A "more turns" approval for this conversation waits on you.
  var waiting = false
  /// Since the last activity: "now", "4m", "2h", "3d".
  var age: String? = nil
  /// Turns taken in the last 10 minutes (from the turn log; 0 without one): how busy its line is drawn.
  var recentTurns = 0
  enum CodingKeys: String, CodingKey { case id, topic, pair, live, pending, turns, mark, approvals, ended, from, to, lastActivityAt = "last_activity_at", sequence, waiting, age, recentTurns = "recent_turns" }
}

/// One row of the B3 sequence view. `side`: "from" (initiator's column) → arrow to the right, "to" → arrow to the left,
/// "both" for a row across both columns (an aggregate of turns, the end).
struct SeqEvent: Encodable, Equatable {
  let kind: String          // "approval" | "turn" | "turns" | "end"
  let side: String          // "from" | "to" | "both"
  let label: String
  let time: String?         // "HH:mm"
  /// An approval a human gave (prompt or CLI): drawn with ✓ in the talking colour.
  let human: Bool
}

/// "claude:harbor" → "harbor": Claude Code is the common case, every other app keeps its prefix.
func displayName(_ address: String) -> String { address.hasPrefix("claude:") ? String(address.dropFirst(7)) : address }

struct PanelModel: Encodable {
  /// "ok" | "connecting" | "bridge_down" | "update_needed" | "no_command" | "error"
  var status: String
  var message: String?
  /// Approvals + held-message entries: the count on the menu-bar icon.
  var iconCount: Int
  var needsYou: [NeedRow]
  var live: [ConversationRow]
  var ended: [ConversationRow]
  var agentCount: Int
  var closedAgents: Int
  var byProject: [AgentGroup]
  var byApp: [AgentGroup]
  /// The filter field appears above ~15 agents.
  var showSearch: Bool
  /// Top bar, after the status dot: "0.2.9 · relay ok · policy v7"; `statusLong` is its tooltip.
  var statusShort: String
  var statusLong: String
  var warnings: [String]
  /// The bridge is older than the CLI: no conversations or projects.
  var incomplete: Bool

  enum CodingKeys: String, CodingKey {
    case status, message, iconCount = "icon_count", needsYou = "needs_you", live, ended, agentCount = "agent_count",
         closedAgents = "closed_agents", byProject = "by_project", byApp = "by_app", showSearch = "show_search",
         statusShort = "status_short", statusLong = "status_long", warnings, incomplete
  }

  static func placeholder(_ status: String, _ message: String?) -> PanelModel {
    PanelModel(status: status, message: message, iconCount: 0, needsYou: [], live: [], ended: [], agentCount: 0, closedAgents: 0,
               byProject: [], byApp: [], showSearch: false, statusShort: "", statusLong: "", warnings: [], incomplete: false)
  }
}

// MARK: building

let searchThreshold = 15

let appNames: [String: String] = ["claude": "Claude Code", "codex": "Codex", "grok": "Grok", "cursor": "Cursor"]
let appOrder = ["claude", "codex", "cursor", "grok"]
func appBadge(_ app: String) -> String {
  switch app { case "claude": return "C"; case "codex": return "X"; case "grok": return "G"; case "cursor": return "Cu"
  default: return String(app.prefix(2)).capitalized }
}
func appOf(_ address: String) -> String { address.split(separator: ":", maxSplits: 1).first.map(String.init) ?? address }

struct Clock {
  let now: Date
  let timeZone: TimeZone
  private static let isoFrac: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
  private static let iso: ISO8601DateFormatter = ISO8601DateFormatter()
  static func parse(_ s: String?) -> Date? { guard let s else { return nil }; return isoFrac.date(from: s) ?? iso.date(from: s) }
  func hm(_ s: String?) -> String? {
    guard let d = Clock.parse(s) else { return nil }
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = timeZone; f.dateFormat = "HH:mm"
    return f.string(from: d)
  }
  /// "now" / "4m" / "2h" / "3d": time since something happened.
  func ago(_ s: String?) -> String? {
    guard let d = Clock.parse(s) else { return nil }
    let mins = Int(now.timeIntervalSince(d) / 60)
    if mins < 1 { return "now" }
    if mins < 60 { return "\(mins)m" }
    return mins < 60 * 24 ? "\(mins / 60)h" : "\(mins / 60 / 24)d"
  }
  /// "7 min" / "1 h 5 min" / "expired": time left on an approval.
  func expiry(_ s: String?) -> String? {
    guard let d = Clock.parse(s) else { return nil }
    let mins = Int((d.timeIntervalSince(now) / 60).rounded(.up))
    if mins <= 0 { return "expired" }
    return mins < 60 ? "\(mins) min" : "\(mins / 60) h\(mins % 60 > 0 ? " \(mins % 60) min" : "")"
  }
}

/// `moreTurns`: agents whose only waiting approvals are "more turns" (extend) requests. The status JSON's
/// `approval` activity covers invites and extends alike; the needs list says which.
func agentState(_ a: Snapshot.Agent, held: Set<String>, moreTurns: Set<String> = []) -> (AgentState, String?) {
  let activity = a.activity ?? a.state ?? "live"
  switch activity {
  case "approval": return (.needsYou, moreTurns.contains(a.address) ? "more turns?" : "invited")
  case "in_conversation": return (.talking, "talking")
  case "working": return (.working, "working")
  case "waiting_first_prompt": return (held.contains(a.address) ? .needsYou : .idle, "1st prompt")
  case "unreachable": return (held.contains(a.address) ? .needsYou : .idle, "unreachable")
  case "closed": return (.closed, "closed")
  default:
    if a.state == "closed" { return (.closed, "closed") }
    return (held.contains(a.address) ? .needsYou : .idle, held.contains(a.address) ? "held" : nil)
  }
}

private func rank(_ s: AgentState) -> Int {
  switch s { case .needsYou: return 0; case .talking: return 1; case .working: return 2; case .idle: return 3; case .closed: return 4 }
}

func makeGroup(id: String, label: String, rows: [(Int, AgentRow)]) -> AgentGroup {
  var bar = StateBar()
  for (_, r) in rows {
    switch r.state { case .talking: bar.talking += 1; case .needsYou: bar.needs_you += 1; case .working: bar.working += 1
    case .idle: bar.idle += 1; case .closed: bar.closed += 1 }
  }
  let sorted = rows.sorted { a, b in rank(a.1.state) != rank(b.1.state) ? rank(a.1.state) < rank(b.1.state) : a.0 < b.0 }.map { $0.1 }
  return AgentGroup(id: id, label: label, count: rows.count, bar: bar, collapsed: bar.active == 0, agents: sorted)
}

func turnsText(_ t: Snapshot.Conversation.Turns?) -> String { "\(t?.used ?? 0)/\(t?.limit.map(String.init) ?? "?")" }

func approvalLine(_ a: Snapshot.Conversation.Approval, clock: Clock) -> String {
  [approvalText(a), clock.hm(a.at)].compactMap { $0 }.joined(separator: " · ")
}

/// "Started: you, in harbor's prompt" (no time).
func approvalText(_ a: Snapshot.Conversation.Approval) -> String {
  let kind: String
  switch a.kind ?? "" {
  case "start": kind = "Started"
  case "accept": kind = "Accepted"
  case "extend": kind = a.turn_limit.map { "Extended to \($0) turns" } ?? "Extended"
  default: kind = (a.kind ?? "approval").capitalized
  }
  let agent = displayName(a.agent ?? "?")
  let how: String
  switch a.via ?? "" {
  case "prompt": how = "you, in \(agent)'s prompt"
  case "cli": how = "you, agentbridge approve for \(agent)"
  case "allow_rule": how = "an allow rule (\(agent))"
  case "bot": how = "\(agent) by itself"
  default: how = "\(a.via ?? "?") (\(agent))"
  }
  return kind + ": " + how
}

/// "✓" when a human approved (prompt or CLI), "rule" when only an allow rule (or a bot) did, "" with no record.
func approvalMark(_ approvals: [Snapshot.Conversation.Approval]) -> String {
  if approvals.contains(where: { $0.via == "prompt" || $0.via == "cli" }) { return "✓" }
  if approvals.contains(where: { $0.via == "allow_rule" }) { return "rule" }
  return ""
}

let endReasons: [String: String] = [
  "ended_by_participant": "ended by an agent", "turn_limit": "turn limit", "declined": "declined", "manual": "ended by you",
  "approval_expired": "approval expired", "invite_expired": "invite expired", "participant_gone": "agent gone",
]

func buildModel(_ s: Snapshot, clock: Clock) -> PanelModel {
  let b = s.bridge
  if let v = s.schema, v > panelSchema {
    return .placeholder("update_needed", "Update agentbridge: this panel reads status schema \(panelSchema), the CLI sent \(v).")
  }
  if b?.running != true {
    var m = PanelModel.placeholder("bridge_down", b?.error ?? "agentbridge is not running")
    m.statusShort = "stopped"
    m.statusLong = "agentbridge \(b?.cli_version ?? "?") · bridge not running"
    return m
  }
  let needs = s.needs_you ?? []
  let held = Set(needs.filter { $0.type == "held_messages" }.compactMap { $0.agent })
  // who is asked to approve (answer_in, else the invitee): an agent asked only for more turns is not "invited"
  let approvalsFor = { (extend: Bool) in Set(needs.filter { $0.type == "approval" && ($0.kind == "extend") == extend }.compactMap { $0.answer_in ?? $0.to }) }
  let moreTurns = approvalsFor(true).subtracting(approvalsFor(false))

  var needRows: [NeedRow] = []
  for (i, n) in needs.enumerated() {
    if n.type == "approval" {
      let target = n.answer_in ?? n.to ?? "?"
      let cli = n.answer_with == "cli"
      let from = displayName(n.from ?? "?"), to = displayName(n.to ?? "?")
      let what: String
      switch n.kind ?? "" {
      case "start": what = "\(from) wants to start a conversation with \(to)"
      case "accept": what = "\(from) invites \(to)"
      case "extend": what = "\(from) asks for more turns with \(to)"
      default: what = "\(from) → \(to)"
      }
      let detail = [what, n.topic.map { "\u{201C}\($0)\u{201D}" }, n.turn_limit.map { "\($0) turns" }].compactMap { $0 }.joined(separator: " · ")
      let topic = n.topic.map { "\u{201C}\($0)\u{201D}" }
      let context: String
      switch n.kind ?? "" {
      case "accept": context = [topic, "from \(from)"].compactMap { $0 }.joined(separator: " · ")
      case "start": context = [topic, "with \(to)"].compactMap { $0 }.joined(separator: " · ")
      case "extend": context = ["more turns" + (n.turn_limit.map { " (to \($0))" } ?? ""), topic].compactMap { $0 }.joined(separator: " · ")
      default: context = topic ?? what
      }
      let id = n.approval_id ?? "approval-\(i)"
      needRows.append(NeedRow(
        id: id, kind: "approval", verb: cli ? "Run agentbridge approve for" : "Answer in", target: displayName(target), app: appOf(target),
        meta: clock.expiry(n.expires_at) ?? (n.kind == "accept" ? "waiting for the session" : ""), context: context, detail: detail,
        copyLabel: cli ? "Copy command agentbridge approve \(id)" : "Copy address \(target)",
        copy: cli ? "agentbridge approve \(id)" : target, expiresAt: n.expires_at))
    } else if n.type == "held_messages" {
      let agent = n.agent ?? "?"; let c = n.count ?? 0
      needRows.append(NeedRow(
        id: "held-\(agent)-\(n.hold ?? "")", kind: "held", verb: "Type in", target: displayName(agent), app: appOf(agent), meta: "\(c) held",
        context: "\(c) message\(c == 1 ? "" : "s") " + (holdReasons[n.hold ?? ""] ?? "waiting"),
        detail: n.text ?? n.hold ?? "", copyLabel: "Copy address \(agent)", copy: agent, expiresAt: nil))
    }
  }

  // agents
  let agents = s.agents ?? []
  var rows: [(Int, AgentRow)] = []
  for (i, a) in agents.enumerated() {
    let app = a.app ?? appOf(a.address)
    let (st, tag) = agentState(a, held: held, moreTurns: moreTurns)
    let name = a.address.hasPrefix(app + ":") ? String(a.address.dropFirst(app.count + 1)) : (a.name ?? a.address)
    rows.append((i, AgentRow(address: a.address, app: app, badge: appBadge(app), name: name, title: a.title, project: a.project?.label, state: st, tag: tag)))
  }
  var projOrder: [String] = []; var projLabel: [String: String] = [:]; var projRows: [String: [(Int, AgentRow)]] = [:]
  for (i, r) in rows {
    let p = agents[i].project
    let key = p.map { "project:\($0.key)" } ?? "project:none"
    if projRows[key] == nil { projOrder.append(key); projRows[key] = [] }
    projLabel[key] = p?.label ?? "Bots & no project"
    projRows[key]!.append((i, r))
  }
  // the CLI already sorts by label then key, projectless last; keep that, but make sure "none" is last
  projOrder.sort { ($0 == "project:none" ? 1 : 0) < ($1 == "project:none" ? 1 : 0) }
  let byProject = projOrder.map { makeGroup(id: $0, label: projLabel[$0]!, rows: projRows[$0]!) }

  var apps: [String] = Array(Set(rows.map { $0.1.app }))
  apps.sort { a, b in
    let ia = appOrder.firstIndex(of: a) ?? appOrder.count, ib = appOrder.firstIndex(of: b) ?? appOrder.count
    return ia != ib ? ia < ib : a < b
  }
  let byApp = apps.map { app in makeGroup(id: "app:\(app)", label: appNames[app] ?? app, rows: rows.filter { $0.1.app == app }) }

  // conversations
  var live: [ConversationRow] = []; var ended: [ConversationRow] = []
  let waitingConvs = Set(needs.filter { $0.type == "approval" && $0.kind == "extend" }.compactMap { $0.conversation_id })
  for c in s.conversations ?? [] {
    var lines = (c.approvals ?? []).map { approvalLine($0, clock: clock) }
    let isLive = c.state != "ended"
    let pending = c.state == "pending"
    if lines.isEmpty {
      lines = [pending ? (c.queued == true ? "Invitation waits for \(displayName(c.to)) to open" : "Invitation not accepted yet") : "No approval record (older conversation)"]
    }
    let endedText = isLive ? nil : [clock.hm(c.ended_at ?? c.last_activity_at), c.end_reason.map { endReasons[$0] ?? $0 }].compactMap { $0 }.joined(separator: " · ")
    var row = ConversationRow(id: c.id, topic: c.topic ?? "", pair: "\(displayName(c.from)) ↔ \(displayName(c.to))", live: isLive, pending: pending,
                              turns: turnsText(c.turns), mark: approvalMark(c.approvals ?? []), approvals: lines, ended: endedText,
                              from: c.from, to: c.to, lastActivityAt: c.last_activity_at, sequence: sequenceEvents(c, clock: clock))
    row.waiting = isLive && !pending && waitingConvs.contains(c.id)
    row.age = clock.ago(c.last_activity_at ?? c.started_at)
    row.recentTurns = (c.turn_log ?? []).filter { Clock.parse($0.at).map { clock.now.timeIntervalSince($0) <= 600 } ?? false }.count
    if isLive { live.append(row) } else { ended.append(row) }
  }

  // top bar: bridge version · relay · policy (short), and the long form for its tooltip
  let relay: (String, String)
  switch b?.relay?.state ?? "unknown" {
  case "connected": relay = ("relay ok", "relay connected"); case "idle": relay = ("relay idle", "relay configured, not connected")
  case "not_configured": relay = ("no relay", "no relay configured")
  default: relay = ("relay ?", "relay state unknown") }
  let policy: (String, String)
  if let p = b?.policy {
    if p.ok == true {
      let v = p.version.map(String.init) ?? "?"
      policy = ("policy v\(v)", "policy v\(v), \((p.mode ?? "?").replacingOccurrences(of: "_", with: " "))")
    } else { policy = ("policy TAMPERED", "policy failed its integrity check: run agentbridge config verify") }
  } else { policy = ("policy ?", "policy unknown") }
  let statusShort = [b?.version ?? "?", relay.0, policy.0].joined(separator: " · ")
  var statusLong = ["bridge \(b?.version ?? "?") running", relay.1, policy.1].joined(separator: " · ")
  if let vm = b?.version_mismatch { statusLong += "\n\(vm)" }

  let open = rows.filter { $0.1.state != .closed }.count
  return PanelModel(
    status: "ok", message: nil, iconCount: needRows.count, needsYou: needRows, live: live, ended: ended,
    agentCount: open, closedAgents: (s.closed_agents ?? 0) + rows.filter { $0.1.state == .closed }.count,
    byProject: byProject, byApp: byApp, showSearch: rows.count > searchThreshold, statusShort: statusShort, statusLong: statusLong,
    warnings: (s.warnings ?? []).compactMap { (w: Snapshot.Warning) -> String? in
      guard let t = w.text else { return nil }
      let who = (w.agents ?? []).map(displayName)
      return who.isEmpty ? t : "\(t): \(who.joined(separator: ", "))"
    },
    incomplete: b?.complete == false)
}

/// The groups that match `query` (case-insensitive) in an agent's address, title or project, or in the group's label.
/// A group whose label matches keeps all its agents. Matching groups are expanded.
func filterGroups(_ groups: [AgentGroup], _ query: String) -> [AgentGroup] {
  let q = query.trimmingCharacters(in: .whitespaces).lowercased()
  if q.isEmpty { return groups }
  return groups.compactMap { g in
    let all = g.label.lowercased().contains(q)
    let agents = all ? g.agents : g.agents.filter { a in
      a.address.lowercased().contains(q) || (a.title?.lowercased().contains(q) ?? false) || (a.project?.lowercased().contains(q) ?? false)
    }
    if agents.isEmpty { return nil }
    return AgentGroup(id: g.id, label: g.label, count: agents.count, bar: g.bar, collapsed: false, agents: agents)
  }
}

/// Decodes one stream line. Returns nil for a heartbeat (nothing to redraw).
enum LineResult { case heartbeat, model(PanelModel), bad(String) }
func decodeLine(_ data: Data, clock: (String?) -> Clock) -> LineResult {
  guard let head = try? JSONDecoder().decode(SnapHead.self, from: data) else { return .bad("not a JSON object") }
  if let v = head.schema, v > panelSchema { return .model(buildModel(Snapshot(schema: v, generated_at: nil, bridge: nil, warnings: nil, needs_you: nil, agents: nil, closed_agents: nil, conversations: nil), clock: clock(nil))) }
  if head.kind == "heartbeat" { return .heartbeat }
  do {
    let s = try JSONDecoder().decode(Snapshot.self, from: data)
    return .model(buildModel(s, clock: clock(s.generated_at)))
  } catch { return .bad("snapshot did not decode: \(error.localizedDescription)") }
}

// MARK: `AgentBridge panel --print-model [--now <iso>] [--filter <text>] [graph options] < snapshot.json`

/// Graph options shared by `--print-model --graph` and `--render-png --window`:
/// `--group-by project|app`, `--expand <group id>[,<group id>…]` (`--expand none` closes every group),
/// `--show-all <group id>[,…]`, `--layout auto|bubbles|list`, `--filter <text>`.
func parseGraphOptions(_ args: [String]) -> GraphOptions {
  var o = GraphOptions()
  var i = 0
  func list(_ v: String) -> Set<String> { v == "none" ? [] : Set(v.split(separator: ",").map(String.init)) }
  while i < args.count {
    let v = i + 1 < args.count ? args[i + 1] : ""
    switch args[i] {
    case "--group-by": o.groupBy = v == "app" ? "app" : "project"; i += 1
    case "--expand": o.expanded = list(v); i += 1
    case "--show-all": o.showAll = list(v); i += 1
    case "--layout": o.layout = ["bubbles", "list"].contains(v) ? v : "auto"; i += 1
    case "--filter": o.query = v; i += 1
    case "--positions": o.positions = (try? JSONDecoder().decode([String: [Double]].self, from: Data(v.utf8))) ?? [:]; i += 1
    default: break
    }
    i += 1
  }
  return o
}

func printModel(_ args: [String]) -> Never {
  var now: Date?; var filter: String?; var graph = false
  var i = 0
  while i < args.count {
    switch args[i] {
    case "--now": i += 1; now = i < args.count ? Clock.parse(args[i]) : nil
    case "--filter": i += 1; filter = i < args.count ? args[i] : nil
    case "--graph": graph = true
    default: break
    }
    i += 1
  }
  let data = FileHandle.standardInput.readDataToEndOfFile()
  // `status --json` is one pretty object; a `--watch --json` capture is one object per line: use the last snapshot
  var candidates: [Data] = [data]
  if (try? JSONSerialization.jsonObject(with: data)) == nil {
    candidates = data.split(separator: UInt8(ascii: "\n")).map { Data($0) }.reversed()
  }
  var model: PanelModel?
  for c in candidates {
    switch decodeLine(c, clock: { gen in Clock(now: now ?? Clock.parse(gen) ?? Date(), timeZone: .current) }) {
    case .model(let m): model = m
    case .heartbeat, .bad: continue
    }
    break
  }
  guard var m = model else {
    FileHandle.standardError.write(Data("no snapshot on stdin\n".utf8)); exit(2)
  }
  let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys, .prettyPrinted]
  if graph {
    FileHandle.standardOutput.write((try? enc.encode(buildGraph(m, parseGraphOptions(args)))) ?? Data("{}".utf8))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
  }
  if let f = filter { m.byProject = filterGroups(m.byProject, f); m.byApp = filterGroups(m.byApp, f) }
  FileHandle.standardOutput.write((try? enc.encode(m)) ?? Data("{}".utf8))
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
