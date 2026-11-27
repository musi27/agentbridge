// Agent panel, step A: the menu-bar dropdown (`AgentBridge panel`). Long-running, unlike every other subcommand.
// Only this file starts AppKit; main.swift calls runPanel() for `panel` and nothing else.
//
// Data: runs `<node> [node args] <cli> status --watch --json` as a child and decodes one JSON object per line
// (docs/status-json.md). The JSON shaping stays in one place (TypeScript); this side only groups and draws.
// The child is restarted with backoff when it exits, and killed and restarted when it goes quiet for longer than
// three heartbeats. Read-only: nothing here approves, declines or reads a transcript.
//
// Usage:
//   AgentBridge panel [--home <dir>] -- <node> [node args…] <cli entry>   menu-bar app (what the LaunchAgent runs)
//   AgentBridge panel --snapshot-file <path> [--open-window]             menu-bar app showing one saved snapshot (design checks)
//   AgentBridge panel --print-model [--now <iso>] [--filter <text>]      no UI: snapshot on stdin → view model JSON on stdout
//   AgentBridge panel --print-model --graph [graph options]              no UI: the graph window's layout as JSON
//   AgentBridge panel --render-png <out.png> --snapshot-file <f> [--window …]   draw the dropdown or the window off-screen
import AppKit
import Combine
import Foundation
import SwiftUI

// MARK: config

struct PanelConfig {
  var command: [String] = []      // node, node args, cli entry
  var home: String?
  var snapshotFile: String?
  /// Open the graph window at launch (design checks and UI tests).
  var openWindow = false
  var homeArgs: [String] { home.map { ["--home", $0] } ?? [] }
}

func parsePanelArgs(_ args: [String]) -> PanelConfig {
  var c = PanelConfig()
  var i = 0
  while i < args.count {
    let a = args[i]
    if a == "--" { c.command = Array(args[(i + 1)...]); break }
    if a == "--home", i + 1 < args.count { c.home = args[i + 1]; i += 2; continue }
    if a == "--snapshot-file", i + 1 < args.count { c.snapshotFile = args[i + 1]; i += 2; continue }
    if a == "--open-window" { c.openWindow = true; i += 1; continue }
    FileHandle.standardError.write(Data("AgentBridge panel: unknown option \(a)\n".utf8)); exit(2)
  }
  return c
}

// MARK: store: child process, line decoding, restart with backoff

final class PanelStore: ObservableObject {
  @Published var model = PanelModel.placeholder("connecting", "Connecting to agentbridge…")
  let config: PanelConfig
  private var child: Process?
  private var buffer = Data()
  private var lastLine = Date()
  private var lastGoodStart = Date.distantPast
  private var backoff: TimeInterval = 1
  private var watchdog: Timer?
  private var stopping = false

  init(config: PanelConfig) { self.config = config }

  func start() {
    if let file = config.snapshotFile {
      guard let data = FileManager.default.contents(atPath: file) else { model = .placeholder("error", "Can't read \(file)"); return }
      apply(data); return
    }
    guard !config.command.isEmpty else {
      model = .placeholder("no_command", "No agentbridge command given. Start the panel with: agentbridge panel start"); return
    }
    spawn()
    watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.checkQuiet() }
  }

  func stop() {
    stopping = true
    watchdog?.invalidate()
    if let c = child, c.isRunning { c.terminate() }
  }

  private func spawn() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: config.command[0])
    p.arguments = Array(config.command.dropFirst()) + ["status", "--watch", "--json"] + config.homeArgs
    let out = Pipe()
    p.standardOutput = out
    p.standardInput = FileHandle.nullDevice
    p.standardError = FileHandle.standardError
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      DispatchQueue.main.async { self?.receive(d) }
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async { self?.exited(status: proc.terminationStatus) }
    }
    do {
      try p.run()
      child = p; buffer = Data(); lastLine = Date(); lastGoodStart = Date()
    } catch {
      model = .placeholder("error", "Can't run agentbridge (\(config.command[0])): \(error.localizedDescription). Retrying in \(Int(backoff)) s.")
      scheduleRestart()
    }
  }

  private func receive(_ d: Data) {
    buffer.append(d)
    while let nl = buffer.firstIndex(of: UInt8(ascii: "\n")) {
      let line = buffer[buffer.startIndex..<nl]
      buffer.removeSubrange(buffer.startIndex...nl)
      if !line.isEmpty { lastLine = Date(); apply(Data(line)) }
    }
  }

  private func apply(_ line: Data) {
    // a saved snapshot is shown as of its own time, so "7 min" stays "7 min"; the live stream uses the clock
    let saved = config.snapshotFile != nil
    switch decodeLine(line, clock: { gen in Clock(now: saved ? (Clock.parse(gen) ?? Date()) : Date(), timeZone: .current) }) {
    case .heartbeat: break
    case .model(let m):
      model = m
      if m.status == "update_needed" { stopping = true; if let c = child, c.isRunning { c.terminate() } }
    case .bad(let why): FileHandle.standardError.write(Data("AgentBridge panel: ignored a line: \(why)\n".utf8))
    }
  }

  private func exited(status: Int32) {
    child = nil
    if stopping { return }
    // a child that ran for a while was healthy: start again quickly
    if Date().timeIntervalSince(lastGoodStart) > 60 { backoff = 1 }
    if model.status == "ok" || model.status == "connecting" {
      model = .placeholder("error", "Lost the connection to agentbridge (exit \(status)). Reconnecting…")
    }
    scheduleRestart()
  }

  private func scheduleRestart() {
    let delay = backoff
    backoff = min(backoff * 2, 30)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, !self.stopping, self.child == nil else { return }
      self.spawn()
    }
  }

  /// The stream sends a heartbeat every 15 s; three missed means the child hangs.
  private func checkQuiet() {
    guard let c = child, c.isRunning, Date().timeIntervalSince(lastLine) > 45 else { return }
    FileHandle.standardError.write(Data("AgentBridge panel: no line for 45 s, restarting the stream\n".utf8))
    c.terminate()
  }

  /// "Turn off menu-bar panel": `agentbridge panel stop` removes the LaunchAgent (and with it this process) and records
  /// the choice so a later `agentbridge init` leaves it off.
  func turnOff(completion: @escaping (String?) -> Void) {
    guard !config.command.isEmpty else { completion("This panel wasn't started by agentbridge; just quit it."); return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: config.command[0])
    p.arguments = Array(config.command.dropFirst()) + ["panel", "stop"] + config.homeArgs
    let err = Pipe(); p.standardError = err; p.standardOutput = err; p.standardInput = FileHandle.nullDevice
    p.terminationHandler = { proc in
      let text = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      DispatchQueue.main.async { completion(proc.terminationStatus == 0 ? nil : text.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
    do { try p.run() } catch { completion(error.localizedDescription) }
  }
}

// MARK: colours (from the app icon: sky = talking, coral = needs you)

extension Color {
  static let abTalk = Color(red: 0x34 / 255, green: 0x96 / 255, blue: 0xEE / 255)
  static let abNeed = Color(red: 0xD9 / 255, green: 0x45 / 255, blue: 0x2F / 255)
  static let abWork = Color(red: 0x2F / 255, green: 0x8A / 255, blue: 0x4F / 255)
  static let abIdle = Color(nsColor: .tertiaryLabelColor)
}
let coral = NSColor(red: 0xD9 / 255, green: 0x45 / 255, blue: 0x2F / 255, alpha: 1)

func stateColor(_ s: AgentState) -> Color {
  switch s { case .talking: return .abTalk; case .needsYou: return .abNeed; case .working: return .abWork; case .idle, .closed: return .abIdle }
}

// MARK: menu-bar icon (option D: "the gap" mark + a coral count pill; hollow bars when the bridge is down)

func menuBarImage(count: Int, down: Bool) -> NSImage {
  let mark = NSSize(width: 18, height: 16)
  let label = count > 99 ? "99+" : "\(count)"
  let font = NSFont.systemFont(ofSize: 10, weight: .semibold)
  let textSize = (label as NSString).size(withAttributes: [.font: font])
  let pillW = count > 0 ? max(14, textSize.width + 8) : 0
  let size = NSSize(width: mark.width + (count > 0 ? 3 + pillW : 0), height: 18)
  let img = NSImage(size: size, flipped: false) { _ in
    // labelColor resolves against the menu bar's appearance at draw time (light/dark, tinted wallpaper)
    NSColor.labelColor.set()
    let y: CGFloat = 2
    let bar1 = NSRect(x: 1.5, y: y + 1, width: 3.4, height: 12), bar2 = NSRect(x: 13.1, y: y + 1, width: 3.4, height: 12)
    if down {
      for r in [bar1, bar2] { let p = NSBezierPath(roundedRect: r.insetBy(dx: 0.6, dy: 0.6), xRadius: 1.2, yRadius: 1.2); p.lineWidth = 1.2; p.stroke() }
    } else {
      NSBezierPath(roundedRect: bar1, xRadius: 1.7, yRadius: 1.7).fill()
      NSBezierPath(roundedRect: bar2, xRadius: 1.7, yRadius: 1.7).fill()
      let d = NSBezierPath(roundedRect: NSRect(x: -1.9, y: -1.9, width: 3.8, height: 3.8), xRadius: 0.8, yRadius: 0.8)
      var t = AffineTransform(translationByX: 9, byY: y + 7); t.rotate(byDegrees: 45)
      d.transform(using: t); d.fill()
    }
    if count > 0 {
      let r = NSRect(x: mark.width + 3, y: 2, width: pillW, height: 14)
      coral.set(); NSBezierPath(roundedRect: r, xRadius: 7, yRadius: 7).fill()
      (label as NSString).draw(at: NSPoint(x: r.midX - textSize.width / 2, y: r.midY - textSize.height / 2),
                               withAttributes: [.font: font, .foregroundColor: NSColor.white])
    }
    return true
  }
  img.isTemplate = false  // the coral pill must keep its colour; the mark follows labelColor instead
  return img
}

// MARK: views

struct PanelView: View {
  @ObservedObject var store: PanelStore
  var onTurnOff: () -> Void
  var onQuit: () -> Void
  var onOpenWindow: () -> Void = {}
  @AppStorage("agentPanel.groupBy") private var groupBy = "project"   // shared with the window (step B)
  @AppStorage("agentPanel.tab") private var tab = "conversations"
  @State private var query = ""
  @State private var toggled: [String: Bool] = [:]     // group id → expanded, overriding the default
  @State private var showAll: Set<String> = []           // groups showing their idle and closed agents too
  @State private var showEnded = false
  @State private var moreLive = false

  var m: PanelModel { store.model }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      if m.status == "ok" {
        if !m.needsYou.isEmpty { NeedsYouSection(rows: m.needsYou) }
        ForEach(m.warnings, id: \.self) { w in
          Text(w).font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        if m.incomplete {
          Text("The bridge is older than this CLI: conversations and projects show after agentbridge init.")
            .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        tabRow
        ViewThatFits(in: .vertical) {
          content
          ScrollView { content }
        }
        .frame(maxHeight: 460)
      } else {
        StateCard(model: m)
      }
      footer
    }
    .padding(10)
    .frame(width: 340)
    .font(.system(size: 12.5))
  }

  private var header: some View {
    HStack(spacing: 8) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 20, height: 20)
      Text("AgentBridge").font(.system(size: 13, weight: .semibold))
      Spacer(minLength: 8)
      HStack(spacing: 5) {
        if m.status == "ok" { Circle().fill(Color.abWork).frame(width: 7, height: 7) }
        else { Circle().strokeBorder(Color.secondary, lineWidth: 1.5).frame(width: 7, height: 7) }
        Text(m.status == "ok" ? m.statusShort : (m.status == "bridge_down" ? "stopped" : ""))
          .font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
      }
      .help(m.statusLong)
    }
  }

  private var tabRow: some View {
    VStack(spacing: 0) {
      HStack(alignment: .bottom, spacing: 18) {
        TabButton(title: "Conversations", count: m.live.count, on: tab == "conversations") { tab = "conversations" }
        TabButton(title: "Agents", count: m.agentCount, on: tab == "agents") { tab = "agents" }
        Spacer()
        if tab == "agents" {
          Menu {
            Picker("Group by", selection: $groupBy) { Text("Project").tag("project"); Text("App").tag("app") }.pickerStyle(.inline)
          } label: { Text(groupBy == "app" ? "App" : "Project").font(.system(size: 11.5)) }
          .menuStyle(.borderlessButton).fixedSize().padding(.bottom, 4)
          .help("Group agents by project or by app")
        }
      }
      Divider()
    }
  }

  @ViewBuilder private var content: some View {
    if tab == "agents" { agentsContent } else { conversationsContent }
  }

  // Conversations: topic first, pair in grey, ✓ / rule with the approvals as tooltip
  private var conversationsContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      if m.live.isEmpty {
        Text("No live conversations. Agents start one when you ask them to.").foregroundColor(.secondary).font(.system(size: 11.5))
      }
      let shown = moreLive ? m.live : Array(m.live.prefix(6))
      ForEach(shown) { c in ConversationRowView(row: c) }
      if m.live.count > shown.count {
        Button("+ \(m.live.count - shown.count) more") { moreLive = true }.buttonStyle(.plain).foregroundColor(.secondary).font(.system(size: 11.5)).padding(.leading, 12)
      }
      if !m.ended.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Divider()
          Button { showEnded.toggle() } label: {
            HStack { Text("\(m.ended.count) ended today"); Spacer(); Image(systemName: showEnded ? "chevron.down" : "chevron.right").font(.system(size: 9)) }
              .contentShape(Rectangle())
          }.buttonStyle(.plain).foregroundColor(.secondary).font(.system(size: 11.5))
          if showEnded { ForEach(m.ended) { c in EndedRowView(row: c) } }
        }
      }
    }
    .padding(.horizontal, 4)
  }

  private var agentsContent: some View {
    let base = groupBy == "app" ? m.byApp : m.byProject
    let groups = filterGroups(base, query)
    return VStack(alignment: .leading, spacing: 4) {
      if m.showSearch {
        HStack(spacing: 5) {
          Image(systemName: "magnifyingglass").font(.system(size: 10)).foregroundColor(.secondary)
          TextField("Filter", text: $query).textFieldStyle(.plain).font(.system(size: 11.5))
        }
        .padding(.horizontal, 7).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color(nsColor: .separatorColor)))
        .padding(.bottom, 4)
      }
      if groups.isEmpty {
        Text(query.isEmpty ? "No agents yet. Open a Claude Code or Codex session." : "Nothing matches \u{201C}\(query)\u{201D}.")
          .foregroundColor(.secondary).font(.system(size: 11.5))
      }
      ForEach(groups) { g in
        let open = toggled[g.id] ?? (!query.isEmpty || !g.collapsed || !m.showSearch)
        GroupHeader(group: g, open: open) { toggled[g.id] = !open }
        if open {
          let all = showAll.contains(g.id) || !query.isEmpty || !m.showSearch
          let rows = all ? g.agents : g.agents.filter { $0.state != .idle && $0.state != .closed }
          ForEach(rows) { a in AgentRowView(row: a) }
          let hidden = g.agents.count - rows.count
          if hidden > 0 {
            let idle = g.agents.filter { $0.state == .idle }.count, closed = g.agents.filter { $0.state == .closed }.count
            Button("+ \(hidden) more" + (idle > 0 ? " · \(idle) idle" : "") + (closed > 0 ? " · \(closed) closed" : "")) { showAll.insert(g.id) }
              .buttonStyle(.plain).foregroundColor(.secondary).font(.system(size: 11.5)).padding(.leading, 33).padding(.vertical, 2)
          }
        }
      }
      if !groups.isEmpty { Legend().padding(.top, 4) }
    }
  }

  private var footer: some View {
    HStack(spacing: 8) {
      Spacer()
      Button("Window", action: onOpenWindow).controlSize(.small).keyboardShortcut("o")
        .help("Open the agent graph window (⌘O)")
      Menu {
        Button("Open window", action: onOpenWindow)
        Divider()
        Button("Turn off menu-bar panel…", action: onTurnOff)
        Button("Quit until next login", action: onQuit)
      } label: { Image(systemName: "ellipsis") }
      .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
      .accessibilityLabel("More: turn off menu-bar panel, quit")
    }
    .font(.system(size: 11))
  }
}

struct TabButton: View {
  let title: String; let count: Int; let on: Bool; let action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 5) {
        HStack(spacing: 4) {
          Text(title).fontWeight(on ? .semibold : .regular).foregroundColor(on ? .primary : .secondary)
          Text("\(count)").foregroundColor(.secondary)
        }
        Rectangle().fill(on ? Color.primary : Color.clear).frame(height: 2)
      }
      .fixedSize().contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(on ? [.isSelected] : [])
  }
}

struct CopyButton: View {
  let value: String; let label: String
  @State private var copied = false
  var body: some View {
    Button {
      NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string)
      copied = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
    } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 11)).frame(width: 18, height: 18) }
    .buttonStyle(.plain).foregroundColor(.abNeed)
    .help(copied ? "Copied" : label).accessibilityLabel(label)
  }
}

struct Diamond: View {
  let color: Color; var size: CGFloat = 7
  var body: some View { RoundedRectangle(cornerRadius: 1.5).fill(color).frame(width: size, height: size).rotationEffect(.degrees(45)) }
}

struct NeedsYouSection: View {
  let rows: [NeedRow]
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(rows) { r in
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 7) {
            Diamond(color: .abNeed)
            Text(r.verb).lineLimit(1).fixedSize()
            AppIconView(app: r.app, size: 15)
            (Text(bareName(r.target)).fontWeight(.semibold) + Text(r.meta.isEmpty ? "" : " · \(r.meta)"))
              .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            CopyButton(value: r.copy, label: r.copyLabel)
          }
          if !r.context.isEmpty {
            Text(r.context).font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1).truncationMode(.tail).padding(.leading, 14)
          }
        }
        .help(r.detail)
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .background(RoundedRectangle(cornerRadius: 8).fill(Color.abNeed.opacity(0.12)))
    .accessibilityElement(children: .contain).accessibilityLabel("Needs you")
  }
}

struct ConversationRowView: View {
  let row: ConversationRow
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Circle().fill(row.pending ? Color.abIdle : Color.abTalk).frame(width: 6, height: 6)
        Text(row.topic.isEmpty ? "(no topic)" : row.topic).fontWeight(.semibold).lineLimit(1)
        Spacer(minLength: 4)
        if !row.mark.isEmpty {
          Text(row.mark).font(.system(size: 11)).foregroundColor(row.mark == "✓" ? .abWork : .secondary)
        }
        Text(row.turns).font(.system(size: 11, design: .monospaced)).foregroundColor(.secondary)
      }
      PairView(from: row.from, to: row.to).padding(.leading, 12)
    }
    .help(row.approvals.joined(separator: "\n"))
  }
}

/// Next to an app icon the "codex:" / "grok:" prefix says the same thing twice: "codex:trailmap" → "trailmap".
func bareName(_ address: String) -> String {
  guard let i = address.firstIndex(of: ":"), address[..<i].allSatisfy({ $0.isLetter }) else { return address }
  return String(address[address.index(after: i)...])
}

/// "[icon] harbor feat/billing ↔ [icon] researcher": each agent with its app's icon (the installed app's, or the
/// letter badge), names truncating in the middle.
struct PairView: View {
  let from: String; let to: String
  var body: some View {
    HStack(spacing: 4) {
      AppIconView(app: appOf(from), size: 13)
      Text(bareName(from)).lineLimit(1).truncationMode(.middle)
      Text("↔").layoutPriority(1)
      AppIconView(app: appOf(to), size: 13)
      Text(bareName(to)).lineLimit(1).truncationMode(.middle)
    }
    .font(.system(size: 11.5)).foregroundColor(.secondary)
    .accessibilityElement(children: .combine).accessibilityLabel("\(displayName(from)) and \(displayName(to))")
  }
}

struct EndedRowView: View {
  let row: ConversationRow
  var body: some View {
    HStack(spacing: 6) {
      Circle().strokeBorder(Color.secondary, lineWidth: 1.2).frame(width: 6, height: 6)
      Text(row.topic.isEmpty ? row.pair : row.topic).lineLimit(1).truncationMode(.tail)
      // who, as two app icons; the names are in the tooltip (the row has no room for them)
      HStack(spacing: 2) {
        AppIconView(app: appOf(row.from), size: 13)
        Text("↔").font(.system(size: 10))
        AppIconView(app: appOf(row.to), size: 13)
      }
      .fixedSize()
      Spacer(minLength: 4)
      Text(row.ended ?? "").font(.system(size: 11))
    }
    .foregroundColor(.secondary).font(.system(size: 11.5))
    .help(([row.pair] + row.approvals).joined(separator: "\n"))
  }
}

struct StateBarView: View {
  let bar: StateBar
  var body: some View {
    GeometryReader { geo in
      let total = CGFloat(max(bar.total, 1))
      HStack(spacing: 0) {
        Rectangle().fill(Color.abTalk).frame(width: geo.size.width * CGFloat(bar.talking) / total)
        Rectangle().fill(Color.abNeed).frame(width: geo.size.width * CGFloat(bar.needs_you) / total)
        Rectangle().fill(Color.abWork).frame(width: geo.size.width * CGFloat(bar.working) / total)
        Rectangle().fill(Color(nsColor: .tertiaryLabelColor)).frame(width: geo.size.width * CGFloat(bar.idle) / total)
        Spacer(minLength: 0)
      }
    }
    .frame(width: 60, height: 6)
    .background(Color(nsColor: .quaternaryLabelColor))
    .clipShape(Capsule())
    .accessibilityLabel("\(bar.talking) talking, \(bar.needs_you) need you, \(bar.working) working, \(bar.idle) idle, \(bar.closed) closed")
  }
}

struct GroupHeader: View {
  let group: AgentGroup; let open: Bool; let toggle: () -> Void
  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 7) {
        Image(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary).frame(width: 10)
        Text(group.label).fontWeight(.semibold).lineLimit(1)
        Spacer(minLength: 6)
        StateBarView(bar: group.bar)
        Text("\(group.count)").font(.system(size: 11.5)).foregroundColor(.secondary).frame(minWidth: 20, alignment: .trailing)
      }
      .padding(4).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(group.label), \(group.count) agents, \(open ? "expanded" : "collapsed")")
  }
}

struct AgentRowView: View {
  let row: AgentRow
  var body: some View {
    HStack(spacing: 6) {
      Group {
        switch row.state {
        case .needsYou: Diamond(color: .abNeed, size: 7)
        case .talking, .working: Circle().fill(stateColor(row.state)).frame(width: 7, height: 7)
        case .idle: Circle().strokeBorder(Color.abWork, lineWidth: 1.5).frame(width: 7, height: 7)
        case .closed: Circle().strokeBorder(Color.secondary, lineWidth: 1.5).frame(width: 7, height: 7)
        }
      }.frame(width: 8)
      Text(row.badge).font(.system(size: 9.5, weight: .semibold, design: .monospaced))
        .padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 3).fill(Color(nsColor: .quaternaryLabelColor)))
      Text(row.name).lineLimit(1).truncationMode(.middle).foregroundColor(row.state == .closed ? .secondary : .primary)
      Spacer(minLength: 4)
      if let tag = row.tag { TagView(text: tag, state: row.state) }
    }
    .padding(.leading, 20).padding(.trailing, 4).padding(.vertical, 2)
    .help([row.address, row.title].compactMap { $0 }.joined(separator: " · "))
    .contextMenu {
      Button("Copy address") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(row.address, forType: .string) }
    }
  }
}

struct TagView: View {
  let text: String; let state: AgentState
  var body: some View {
    let c: Color = state == .talking ? .abTalk : state == .needsYou ? .abNeed : state == .working ? .abWork : .secondary
    Text(text).font(.system(size: 10.5)).foregroundColor(c)
      .padding(.horizontal, 5).padding(.vertical, 1)
      .background(RoundedRectangle(cornerRadius: 4).fill(c.opacity(0.12)))
  }
}

struct Legend: View {
  var body: some View {
    HStack(spacing: 10) {
      item(.abTalk, "talking"); item(.abNeed, "needs you"); item(.abWork, "working"); item(Color(nsColor: .tertiaryLabelColor), "idle")
    }
    .font(.system(size: 10.5)).foregroundColor(.secondary)
  }
  func item(_ c: Color, _ t: String) -> some View {
    HStack(spacing: 4) { RoundedRectangle(cornerRadius: 2).fill(c).frame(width: 10, height: 5); Text(t) }
  }
}

struct StateCard: View {
  let model: PanelModel
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch model.status {
      case "bridge_down":
        Text("agentbridge isn’t running").fontWeight(.semibold)
        Text("Your agents can’t reach each other until it starts. It starts by itself when a Claude Code session opens, or now from a terminal:")
          .foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 6) {
          Text("agentbridge start").font(.system(size: 11.5, design: .monospaced))
            .padding(.horizontal, 7).padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
          Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString("agentbridge start", forType: .string) }.controlSize(.small)
        }
        Text("Checking again every few seconds…").font(.system(size: 11.5)).foregroundColor(.secondary)
      case "update_needed":
        Text("Update agentbridge").fontWeight(.semibold)
        Text(model.message ?? "").foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        Text("npm install -g @musi27/agentbridge\nagentbridge init").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
      default:
        Text(model.message ?? "").foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 9).fill(model.status == "update_needed" ? Color.orange.opacity(0.14) : Color(nsColor: .quaternaryLabelColor).opacity(0.5)))
  }
}

// MARK: app

final class PanelAppDelegate: NSObject, NSApplicationDelegate {
  let store: PanelStore
  var item: NSStatusItem!
  let popover = NSPopover()
  var sub: AnyCancellable?
  lazy var graphWindow = GraphWindowController(store: store)

  init(store: PanelStore) { self.store = store }

  func openWindow() {
    popover.performClose(nil)
    graphWindow.show()
  }

  /// A click on the Dock icon (only there while the window is open) brings the window back.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag { graphWindow.show() }
    return true
  }

  func applicationDidFinishLaunching(_ n: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    item.button?.target = self
    item.button?.action = #selector(toggle)
    item.button?.setAccessibilityLabel("AgentBridge")
    let host = NSHostingController(rootView: PanelView(store: store, onTurnOff: { [weak self] in self?.confirmTurnOff() }, onQuit: { NSApp.terminate(nil) },
                                                       onOpenWindow: { [weak self] in self?.openWindow() }))
    host.sizingOptions = .preferredContentSize
    popover.contentViewController = host
    popover.behavior = .transient
    sub = store.$model.receive(on: RunLoop.main).sink { [weak self] m in self?.updateIcon(m) }
    store.start()
    if store.config.openWindow { DispatchQueue.main.async { self.openWindow() } }
  }

  func applicationWillTerminate(_ n: Notification) { store.stop() }

  func updateIcon(_ m: PanelModel) {
    let down = m.status != "ok"
    item.button?.image = menuBarImage(count: down ? 0 : m.iconCount, down: down)
    item.button?.toolTip = down ? "AgentBridge: \(m.message ?? "not connected")"
      : m.iconCount > 0 ? "AgentBridge: \(m.iconCount) waiting on you" : "AgentBridge"
  }

  @objc func toggle() {
    guard let b = item.button else { return }
    if popover.isShown { popover.performClose(nil) }
    else { popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY); popover.contentViewController?.view.window?.makeKey() }
  }

  func confirmTurnOff() {
    popover.performClose(nil)
    let a = NSAlert()
    a.messageText = "Turn off the menu-bar panel?"
    a.informativeText = "It stays off after login, and agentbridge init won't turn it back on. To turn it on again, run: agentbridge panel start"
    a.addButton(withTitle: "Turn Off")
    a.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard a.runModal() == .alertFirstButtonReturn else { return }
    store.turnOff { err in
      if let err {
        let e = NSAlert(); e.messageText = "Couldn't turn off the panel"
        e.informativeText = "\(err)\n\nRun agentbridge panel stop in a terminal instead."
        e.runModal()
      } else {
        NSApp.terminate(nil)  // usually launchd has already stopped us
      }
    }
  }
}

/// One panel per user: a second `AgentBridge panel` (say, started by hand while the LaunchAgent's runs) exits quietly.
func singleInstance() -> Bool {
  let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("live.musi.agentbridge.panel.lock")
  let fd = open(path, O_CREAT | O_RDWR, 0o600)
  guard fd >= 0 else { return true }
  return flock(fd, LOCK_EX | LOCK_NB) == 0  // fd stays open (and locked) for the life of the process
}

/// `panel --render-png <out.png> --snapshot-file <f> [--tab agents|conversations] [--dark]`: draws the dropdown off-screen
/// into a PNG (design checks and PR screenshots; needs no Screen Recording permission). Never shown, no status item.
/// `--window [graph options] [--select edge:<id>|conv:<id>|node:<id>] [--size <w>x<h>] [--appearance light|dark]` draws the
/// graph window instead
/// (graph options as for `--print-model --graph`; nothing is written to the app's preferences).
func renderPNG(_ args: [String]) -> Never {
  var out = "", file = "", tab = "conversations", dark = false, window = false, select = "", size = NSSize(width: 1060, height: 640)
  var i = 0
  while i < args.count {
    switch args[i] {
    case "--render-png": out = i + 1 < args.count ? args[i + 1] : ""; i += 1
    case "--snapshot-file": file = i + 1 < args.count ? args[i + 1] : ""; i += 1
    case "--tab": tab = i + 1 < args.count ? args[i + 1] : tab; i += 1
    case "--dark": dark = true
    case "--window": window = true
    case "--select": select = i + 1 < args.count ? args[i + 1] : ""; i += 1
    case "--size":
      let wh = (i + 1 < args.count ? args[i + 1] : "").split(separator: "x").compactMap { Double($0) }
      if wh.count == 2 { size = NSSize(width: wh[0], height: wh[1]) }
      i += 1
    default: break
    }
    i += 1
  }
  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)
  if dark { app.appearance = NSAppearance(named: .darkAqua) }
  let store = PanelStore(config: PanelConfig(snapshotFile: file))
  store.start()
  let view: NSView
  if window {
    let o = parseGraphOptions(args)
    // a throwaway, never-saved defaults domain: the render must not change the person's window settings
    let defaults = UserDefaults(suiteName: "live.musi.agentbridge.render") ?? .standard
    let look = args.firstIndex(of: "--appearance").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "system"
    defaults.register(defaults: ["agentPanel.groupBy": o.groupBy, "agentPanel.windowLayout": o.layout == "list" ? "list" : "bubbles", "agentPanel.windowAppearance": look])
    let parts = select.split(separator: ":", maxSplits: 1).map(String.init)
    let sel: GraphSelection
    switch parts.first ?? "" {
    case "edge" where parts.count == 2: sel = .edge(parts[1])
    case "conv" where parts.count == 2: sel = .conversation(parts[1], from: nil)
    case "node" where parts.count == 2: sel = .node(parts[1])
    default: sel = .none
    }
    let ui = GraphUI()
    // --zoom 0.5 | 1.8: the bubbles at that zoom (1 = fit), to check the dots and cards levels off-screen
    if let z = args.firstIndex(of: "--zoom").flatMap({ $0 + 1 < args.count ? Double(args[$0 + 1]) : nil }) { ui.zoom = z }
    view = NSHostingView(rootView: GraphWindowView(store: store, ui: ui, defaults: defaults, options: o, selection: sel)
      .frame(width: size.width, height: size.height).background(Color(nsColor: .windowBackgroundColor)))
  } else {
    UserDefaults.standard.set(tab, forKey: "agentPanel.tab")
    view = NSHostingView(rootView: PanelView(store: store, onTurnOff: {}, onQuit: {}).background(Color(nsColor: .windowBackgroundColor)))
    size = view.fittingSize
  }
  let win = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
  win.contentView = view
  view.frame = NSRect(origin: .zero, size: size)
  view.layoutSubtreeIfNeeded()
  RunLoop.main.run(until: Date().addingTimeInterval(0.3))
  guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { exit(1) }
  view.cacheDisplay(in: view.bounds, to: rep)
  guard let png = rep.representation(using: .png, properties: [:]), (try? png.write(to: URL(fileURLWithPath: out))) != nil else { exit(1) }
  exit(0)
}

func runPanel(_ args: [String]) -> Never {
  if args.first == "--print-model" { printModel(Array(args.dropFirst())) }
  if args.contains("--render-png") { renderPNG(args) }
  let config = parsePanelArgs(args)
  if config.snapshotFile == nil && !singleInstance() {
    FileHandle.standardError.write(Data("AgentBridge panel: already running\n".utf8)); exit(0)
  }
  signal(SIGPIPE, SIG_IGN)
  let store = PanelStore(config: config)
  // launchd's bootout and `kill` send SIGTERM: stop the child stream, then exit cleanly (KeepAlive won't restart a clean exit)
  signal(SIGTERM, SIG_IGN)
  let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  term.setEventHandler { store.stop(); exit(0) }
  term.resume()
  let app = NSApplication.shared
  let delegate = PanelAppDelegate(store: store)
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  withExtendedLifetime((delegate, term)) { app.run() }
  exit(0)
}
