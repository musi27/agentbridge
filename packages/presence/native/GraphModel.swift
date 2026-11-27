// Agent panel, step B: the graph window's model and layout. Foundation only (no AppKit or SwiftUI), so
// `AgentBridge panel --print-model --graph …` prints it as JSON and the layout is testable without any UI.
//
// From the dropdown's PanelModel (same `status --watch --json` stream) to what the window draws:
// - B1 bubbles: groups (By project | By app) are circles sized by agent count; an opened group is a box of agent
//   dots, its idle and closed agents folded into one "+N" node. Live conversations between two nodes merge into one
//   line with a count; a pending invitation is a dashed coral line.
// - B2 arc list: the same nodes as rows, conversations as arcs in a left gutter. Used when a view has more than
//   `graphThreshold` visible nodes (or when the person picks List).
// - B3 sequence: built per conversation in PanelModel (`ConversationRow.sequence`); see sequenceEvents below.
// Read-only like the dropdown: nothing here approves, declines or reads a transcript.
import Foundation

/// Bubbles while the visible nodes number this many or fewer; the arc list above it (design: "about 12").
let graphThreshold = 12

struct GraphNode: Encodable, Identifiable {
  let id: String            // a group id ("project:<key>", "app:<app>"), an agent address, or "more:<group id>"
  let kind: String          // "group" | "agent" | "more"
  let label: String
  let sub: String           // "18 agents" | the agent's project or app | "13 idle · 2 closed"
  let mix: String?          // groups: "C10 · X5 · G3"
  /// Groups: agents per app, in app order (the chip shows each app's icon with its count).
  let apps: [AppCount]?
  let state: AgentState?    // agents only
  let bar: StateBar?        // groups only
  let badge: String?        // agents only: "C", "X", "G"
  let app: String?          // agents only: "claude", "codex", "grok", …
  let tag: String?          // agents only: "talking", "invited", "more turns?", …
  let group: String         // the group this node belongs to (a collapsed group: itself)
  // bubbles: centre and radius; list: x is the gutter, y the row's centre, r the row's half height
  var x: Double = 0, y: Double = 0, r: Double = 0
  /// Bubbles, closed groups: the donut chip's size (r is then half its height). 0 for every other node.
  var w: Double = 0, h: Double = 0
}

struct AppCount: Encodable, Equatable { let app: String; let count: Int }

/// An opened group. Bubbles: the dashed box around its agents. List: its header row (y = header centre).
struct GraphBox: Encodable, Identifiable {
  let id: String; let label: String; let count: Int
  var x: Double = 0, y: Double = 0, w: Double = 0, h: Double = 0
}

/// One drawn line: every live conversation between the same two nodes, merged.
struct GraphEdge: Encodable, Identifiable {
  let id: String            // "<a>|<b>", a < b
  let a: String; let b: String
  /// Conversation ids, most recent activity first.
  let conversations: [String]
  let live: Int             // active conversations
  let pending: Int          // invitations not accepted yet (dashed coral)
  /// Both ends fold into the same collapsed group: drawn as "↺ N inside" by that group.
  var inside: Bool { a == b }
  let label: String         // "3 conversations" | "1" | "invite" | "1 + invite"
  /// Who started the conversations on this line: "ab" (a → b), "ba", or "both". The arrowheads.
  var direction = "ab"
  /// Live conversations with a "more turns" approval waiting on you (drawn dashed coral).
  var waiting = 0
  /// Turns in the last 10 minutes across the line's conversations: its thickness.
  var recent = 0
  /// The richer pill at 100%: "11/20 turns · 2m" | "2 conversations · 2m" | "waiting on you · 4m" | "invite".
  var detail = ""
  enum CodingKeys: String, CodingKey { case id, a, b, conversations, live, pending, inside, label, direction, waiting, recent, detail }
  func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id); try c.encode(a, forKey: .a); try c.encode(b, forKey: .b)
    try c.encode(conversations, forKey: .conversations); try c.encode(live, forKey: .live); try c.encode(pending, forKey: .pending)
    try c.encode(inside, forKey: .inside); try c.encode(label, forKey: .label)
    try c.encode(direction, forKey: .direction); try c.encode(waiting, forKey: .waiting); try c.encode(recent, forKey: .recent); try c.encode(detail, forKey: .detail)
  }
}

struct GraphModel: Encodable {
  let groupBy: String       // "project" | "app"
  let layout: String        // "bubbles" | "list"
  /// The layout was picked by the node count, not by the person.
  let auto: Bool
  let visibleNodes: Int
  let threshold: Int
  let expanded: [String]
  let width: Double
  let height: Double
  let nodes: [GraphNode]
  let boxes: [GraphBox]
  let edges: [GraphEdge]
  /// The ring of closed chips (bubbles, no opened group): the person can drag chips, and their spots are kept.
  var movable = false
  /// What the layout added to the ring's own coordinates (centred on 0, 0) to place it in the canvas. A dragged chip's
  /// spot is saved as its ring coordinates, `x - originX`, `y - originY`, so it holds when the canvas resizes.
  var originX = 0.0, originY = 0.0
  enum CodingKeys: String, CodingKey {
    case groupBy = "group_by", layout, auto, visibleNodes = "visible_nodes", threshold, expanded, width, height, nodes, boxes, edges
    case movable, originX = "origin_x", originY = "origin_y"
  }
}

struct GraphOptions {
  var groupBy = "project"
  /// nil: automatic (open every group when that still fits the bubbles, otherwise none).
  var expanded: Set<String>? = nil
  /// Opened groups that also show their idle and closed agents instead of one "+N" node.
  var showAll: Set<String> = []
  var layout = "auto"       // "auto" | "bubbles" | "list"
  var query = ""
  /// Chips the person moved: group id → [x, y] in ring coordinates (see GraphModel.originX).
  var positions: [String: [Double]] = [:]
  /// A chip being dragged right now, same coordinates: drawn there, but not counted in the canvas size until it is
  /// dropped (so the canvas doesn't shift under the pointer mid-drag).
  var dragging: [String: [Double]] = [:]
}

// MARK: building

func appCounts(_ agents: [AgentRow]) -> [AppCount] {
  var counts: [String: Int] = [:]
  for a in agents { counts[a.app, default: 0] += 1 }
  return counts.keys.sorted { x, y in
    let ix = appOrder.firstIndex(of: x) ?? appOrder.count, iy = appOrder.firstIndex(of: y) ?? appOrder.count
    return ix != iy ? ix < iy : x < y
  }.map { AppCount(app: $0, count: counts[$0]!) }
}

/// A closed group's donut chip: the state donut, the name (up to ~18 characters before it truncates), then one icon
/// and count per app. Widths are estimates the view's fonts fit inside.
let chipHeight = 36.0
let chipHeightTwoRows = 52.0
func chipWidth(label: String, apps: [AppCount]) -> Double {
  // padding 22 + donut 22 + three 8pt gaps + 4pt spacer = 72; then the name; then per app icon 16 + 3 + digits, 8 apart
  let name = Double(min(label.count, 18)) * 7.8
  let icons = apps.reduce(0.0) { $0 + 16 + 3 + Double(String($1.count).count) * 7 } + Double(max(apps.count - 1, 0)) * 8
  return min(250, max(116, 72 + name + icons + 4))
}

func appMix(_ agents: [AgentRow]) -> String {
  var counts: [String: Int] = [:]
  for a in agents { counts[a.app, default: 0] += 1 }
  let apps = counts.keys.sorted { x, y in
    let ix = appOrder.firstIndex(of: x) ?? appOrder.count, iy = appOrder.firstIndex(of: y) ?? appOrder.count
    return ix != iy ? ix < iy : x < y
  }
  return apps.map { "\(appBadge($0))\(counts[$0]!)" }.joined(separator: " · ")
}

private struct Placed { let group: AgentGroup; let open: Bool; let shown: [AgentRow]; let folded: [AgentRow] }

func buildGraph(_ m: PanelModel, _ o: GraphOptions) -> GraphModel {
  let groups = filterGroups(o.groupBy == "app" ? m.byApp : m.byProject, o.query)
  let liveConvs = m.live
  var endpoints = Set<String>()
  for c in liveConvs { endpoints.insert(c.from); endpoints.insert(c.to) }

  func split(_ g: AgentGroup) -> ([AgentRow], [AgentRow]) {
    if o.showAll.contains(g.id) { return (g.agents, []) }
    let shown = g.agents.filter { $0.state == .talking || $0.state == .needsYou || $0.state == .working || endpoints.contains($0.address) }
    let shownSet = Set(shown.map { $0.address })
    return (shown, g.agents.filter { !shownSet.contains($0.address) })
  }
  func cost(_ g: AgentGroup, open: Bool) -> Int {
    guard open else { return 1 }
    let (s, f) = split(g); return s.count + (f.isEmpty ? 0 : 1)
  }
  let expanded: Set<String>
  if let e = o.expanded { expanded = e }
  else if !o.query.isEmpty { expanded = Set(groups.map { $0.id }) }
  else {
    let all = groups.reduce(0) { $0 + cost($1, open: true) }
    expanded = all <= graphThreshold ? Set(groups.map { $0.id }) : []
  }
  let placed: [Placed] = groups.map { g in
    let open = expanded.contains(g.id)
    let (s, f) = open ? split(g) : ([], [])
    return Placed(group: g, open: open, shown: s, folded: f)
  }
  let visible = placed.reduce(0) { $0 + ($1.open ? $1.shown.count + ($1.folded.isEmpty ? 0 : 1) : 1) }
  let layout = o.layout == "auto" ? (visible <= graphThreshold ? "bubbles" : "list") : o.layout

  // nodes, and where every agent address lands (its own dot, or its collapsed group)
  var nodes: [GraphNode] = []; var boxes: [GraphBox] = []
  var nodeOf: [String: String] = [:]
  for p in placed {
    let g = p.group
    if !p.open {
      nodes.append(GraphNode(id: g.id, kind: "group", label: g.label, sub: "\(g.count) agent\(g.count == 1 ? "" : "s")", mix: appMix(g.agents), apps: appCounts(g.agents),
                             state: nil, bar: g.bar, badge: nil, app: nil, tag: nil, group: g.id))
      for a in g.agents { nodeOf[a.address] = g.id }
      continue
    }
    boxes.append(GraphBox(id: g.id, label: g.label, count: g.count))
    for a in p.shown {
      let sub = o.groupBy == "app" ? (a.project ?? "no project") : (appNames[a.app] ?? a.app)
      nodes.append(GraphNode(id: a.address, kind: "agent", label: a.name, sub: sub, mix: nil, apps: nil, state: a.state, bar: nil, badge: a.badge, app: a.app, tag: a.tag, group: g.id))
      nodeOf[a.address] = a.address
    }
    if !p.folded.isEmpty {
      let idle = p.folded.filter { $0.state == .idle }.count, closed = p.folded.filter { $0.state == .closed }.count
      let sub = [idle > 0 ? "\(idle) idle" : nil, closed > 0 ? "\(closed) closed" : nil].compactMap { $0 }.joined(separator: " · ")
      nodes.append(GraphNode(id: "more:\(g.id)", kind: "more", label: "+\(p.folded.count)", sub: sub, mix: nil, apps: nil, state: nil, bar: nil, badge: nil, app: nil, tag: nil, group: g.id))
      for a in p.folded { nodeOf[a.address] = "more:\(g.id)" }
    }
  }

  // merged edges (live conversations only; ended ones are listed in the side pane). Order: first seen = most recent.
  var order: [String] = []; var acc: [String: (a: String, b: String, convs: [ConversationRow], live: Int, pending: Int)] = [:]
  for c in liveConvs {
    guard let na = nodeOf[c.from], let nb = nodeOf[c.to] else { continue }   // filtered out
    let (a, b) = na <= nb ? (na, nb) : (nb, na)
    let id = "\(a)|\(b)"
    if acc[id] == nil { order.append(id); acc[id] = (a, b, [], 0, 0) }
    acc[id]!.convs.append(c)
    if c.pending { acc[id]!.pending += 1 } else { acc[id]!.live += 1 }
  }
  let edges: [GraphEdge] = order.map { id in
    let e = acc[id]!
    let label: String
    if e.pending == 0 { label = e.live == 1 ? "1" : "\(e.live) conversations" }
    else if e.live == 0 { label = e.pending == 1 ? "invite" : "\(e.pending) invites" }
    else { label = "\(e.live) + invite\(e.pending == 1 ? "" : "s")" }
    var edge = GraphEdge(id: id, a: e.a, b: e.b, conversations: e.convs.map { $0.id }, live: e.live, pending: e.pending, label: label)
    let dirs = Set(e.convs.map { nodeOf[$0.from] == e.a ? "ab" : "ba" })
    edge.direction = e.a == e.b ? "both" : dirs.count == 1 ? dirs.first! : "both"
    edge.waiting = e.convs.filter { $0.waiting }.count
    edge.recent = e.convs.reduce(0) { $0 + $1.recentTurns }
    edge.detail = edgeDetail(e.convs, label: label)
    return edge
  }

  // a chip whose group has conversations inside it gets a second row ("↺ 1 internal convo"), so it is taller
  let inside = Set(edges.filter { $0.inside }.map { $0.a })
  var links: [String: [String: Int]] = [:]
  for e in edges where !e.inside { links[e.a, default: [:]][e.b, default: 0] += e.live + e.pending; links[e.b, default: [:]][e.a, default: 0] += e.live + e.pending }
  var origin: (Double, Double)? = nil
  let (w, h) = layout == "list" ? layoutList(&nodes, &boxes, placed)
    : layoutBubbles(&nodes, &boxes, placed, inside: inside, links: links, positions: o.positions, dragging: o.dragging, origin: &origin)
  var g = GraphModel(groupBy: o.groupBy, layout: layout, auto: o.layout == "auto", visibleNodes: visible, threshold: graphThreshold,
                     expanded: groups.map { $0.id }.filter { expanded.contains($0) }, width: w, height: h, nodes: nodes, boxes: boxes, edges: edges)
  if let origin { g.movable = true; g.originX = origin.0; g.originY = origin.1 }
  return g
}

/// The pill on a line at 100%: what is happening on it, never message text.
func edgeDetail(_ convs: [ConversationRow], label: String) -> String {
  let live = convs.filter { !$0.pending }
  guard let first = live.first else { return label }   // invitations only
  let age = first.age.map { " · \($0)" } ?? ""
  if live.contains(where: { $0.waiting }) { return "waiting on you\(age)" }
  if convs.count == 1 { return "\(first.turns) turns\(age)" }
  return "\(label)\(age)"
}

/// One live conversation drawn agent to agent when the graph is zoomed in (cards). Endpoint addresses, not nodes.
struct CardLine: Encodable, Identifiable {
  let id: String; let from: String; let to: String
  let pending: Bool; let waiting: Bool; let recent: Int
  let detail: String
}

func cardLines(_ convs: [ConversationRow]) -> [CardLine] {
  convs.map { c in
    CardLine(id: c.id, from: c.from, to: c.to, pending: c.pending, waiting: c.waiting, recent: c.recentTurns,
             detail: c.pending ? "invite" : edgeDetail([c], label: "1"))
  }
}

/// Zoomed in, a closed group opens into this many agent cards (the rest fold into "+N more"): 3 at 150%, one more
/// every 25% after that.
func cardsShown(_ count: Int, zoom: Double) -> Int { min(count, 3 + max(0, Int((zoom - 1.5) / 0.25))) }

/// What a card says under the agent's name: its live conversation's turns and age, else its state.
func agentCardLine(_ a: AgentRow, _ convs: [ConversationRow]) -> String {
  let mine = convs.filter { !$0.pending && ($0.from == a.address || $0.to == a.address) }
  let state: String
  switch a.state {
  case .needsYou: state = "needs you"; case .talking: state = "talking"; case .working: state = "working"
  case .idle: state = a.tag ?? "idle"; case .closed: state = "closed" }
  guard let c = mine.first else { return state }
  let extra = mine.count > 1 ? " · \(mine.count) convos" : ""
  return [state, "\(c.turns)\(extra)", c.age].compactMap { $0 }.joined(separator: " · ")
}

// MARK: layout

let graphWidth = 640.0
let bubblesHeight = 440.0


/// Bubbles. No opened group: the circles sit on an ellipse, in group order. Opened groups: their boxes stack on the
/// left (agent dots in a grid of three), the closed groups' circles in a column on the right.
/// Ring order for the closed groups: a chain that puts groups who talk next to each other (shorter lines, fewer
/// crossings), the busiest first; groups with no lines keep their order at the end.
func ringOrder(_ ids: [String], _ links: [String: [String: Int]]) -> [String] {
  let total = { (id: String) in links[id]?.values.reduce(0, +) ?? 0 }
  var left = ids.filter { total($0) > 0 }
  var out: [String] = []
  while !left.isEmpty {
    let next: String
    if let last = out.last, let best = left.max(by: { (links[last]?[$0] ?? 0, total($0)) < (links[last]?[$1] ?? 0, total($1)) }), (links[last]?[best] ?? 0) > 0 {
      next = best
    } else {
      next = left.max { total($0) < total($1) }!   // a new chain: the busiest left (first in order on a tie)
    }
    out.append(next); left.removeAll { $0 == next }
  }
  return out + ids.filter { total($0) == 0 }
}

private func layoutBubbles(_ nodes: inout [GraphNode], _ boxes: inout [GraphBox], _ placed: [Placed], inside: Set<String>, links: [String: [String: Int]] = [:],
                           positions: [String: [Double]] = [:], dragging: [String: [Double]] = [:], origin: inout (Double, Double)?) -> (Double, Double) {
  var idx: [String: Int] = [:]
  for (i, n) in nodes.enumerated() { idx[n.id] = i }
  let closed = placed.filter { !$0.open }
  let open = placed.filter { $0.open }
  if open.isEmpty {
    let order = ringOrder(closed.map { $0.group.id }, links)
    let n = order.count
    for id in order {
      let i = idx[id]!
      nodes[i].w = chipWidth(label: nodes[i].label, apps: nodes[i].apps ?? [])
      nodes[i].h = inside.contains(id) ? chipHeightTwoRows : chipHeight; nodes[i].r = nodes[i].h / 2
    }
    // chips are wide and short: a flat ellipse, as small as it can be with every two chips at least 24 apart across or
    // 26 down; two chips with a line between them need room for its pill: 130 across or 44 down
    func place(_ f: Double) {
      for (k, id) in order.enumerated() {
        let i = idx[id]!
        let angle = n == 2 ? (k == 0 ? Double.pi : 0) : -Double.pi * 0.75 + 2 * Double.pi * Double(k) / Double(max(n, 1))
        nodes[i].x = n == 1 ? 0 : (n <= 2 ? 170 : 230) * f * cos(angle)
        nodes[i].y = n <= 2 ? 0 : 160 * f * sin(angle)
      }
    }
    func clear() -> Bool {
      for a in order { for b in order where a < b {
        let p = nodes[idx[a]!], q = nodes[idx[b]!]
        let linked = (links[a]?[b] ?? 0) > 0
        if abs(p.x - q.x) < (p.w + q.w) / 2 + (linked ? 130 : 24) && abs(p.y - q.y) < (p.h + q.h) / 2 + (linked ? 44 : 26) { return false }
      } }
      return true
    }
    var f = 0.5
    place(f)
    while !clear() && f < 1.6 { f += 0.05; place(f) }
    // chips the person dragged sit where they left them (the others keep the automatic ring)
    for id in order { if let p = positions[id], p.count == 2, p[0].isFinite, p[1].isFinite { nodes[idx[id]!].x = p[0]; nodes[idx[id]!].y = p[1] } }
    // the canvas is the chips' bounding box plus a margin (centred in the window by the view)
    let pad = 16.0
    let minX = order.map { nodes[idx[$0]!].x - nodes[idx[$0]!].w / 2 }.min() ?? 0, maxX = order.map { nodes[idx[$0]!].x + nodes[idx[$0]!].w / 2 }.max() ?? 0
    let minY = order.map { nodes[idx[$0]!].y - nodes[idx[$0]!].h / 2 }.min() ?? 0, maxY = order.map { nodes[idx[$0]!].y + nodes[idx[$0]!].h / 2 }.max() ?? 0
    for id in order { nodes[idx[id]!].x += pad - minX; nodes[idx[id]!].y += pad - minY }
    origin = (pad - minX, pad - minY)
    for id in order { if let p = dragging[id], p.count == 2 { nodes[idx[id]!].x = p[0] + pad - minX; nodes[idx[id]!].y = p[1] + pad - minY } }
    return (maxX - minX + 2 * pad, maxY - minY + 2 * pad)
  }
  if closed.isEmpty { return layoutBoxGrid(&nodes, &boxes, open) }
  let boxX = 16.0, boxW = 420.0
  let cols = 3
  let cellW = (boxW - 16) / Double(cols), cellH = 62.0
  var y = 16.0
  for p in open {
    let members = nodes.indices.filter { nodes[$0].group == p.group.id && nodes[$0].kind != "group" }
    let rows = max(1, (members.count + cols - 1) / cols)
    let h = 30 + Double(rows) * cellH + 6
    boxes[boxes.firstIndex { $0.id == p.group.id }!].x = boxX
    boxes[boxes.firstIndex { $0.id == p.group.id }!].y = y
    boxes[boxes.firstIndex { $0.id == p.group.id }!].w = boxW
    boxes[boxes.firstIndex { $0.id == p.group.id }!].h = h
    for (k, i) in members.enumerated() {
      nodes[i].x = boxX + 8 + cellW * (Double(k % cols) + 0.5)
      nodes[i].y = y + 30 + cellH * Double(k / cols) + 18
      nodes[i].r = nodes[i].kind == "more" ? 12 : 10
    }
    y += h + 14
  }
  let height = max(bubblesHeight, y + 2)
  if !closed.isEmpty {
    let colX = boxX + boxW + (graphWidth - boxX - boxW) / 2
    let slot = height / Double(closed.count)
    for (k, p) in closed.enumerated() {
      let i = idx[p.group.id]!
      nodes[i].x = colX
      nodes[i].y = slot * (Double(k) + 0.5)
      nodes[i].w = min(chipWidth(label: nodes[i].label, apps: nodes[i].apps ?? []), graphWidth - boxX - boxW - 20)
      nodes[i].h = inside.contains(nodes[i].id) ? chipHeightTwoRows : chipHeight; nodes[i].r = nodes[i].h / 2
    }
  }
  return (graphWidth, height)
}

/// Every group open: the boxes side by side, up to three per row, each as wide as its agents need.
private func layoutBoxGrid(_ nodes: inout [GraphNode], _ boxes: inout [GraphBox], _ open: [Placed]) -> (Double, Double) {
  let gap = 14.0, cellW = 128.0, cellH = 62.0, maxPerRow = 3
  var y = 16.0
  var start = 0
  while start < open.count {
    let row = Array(open[start..<min(open.count, start + maxPerRow)])
    let members = row.map { p in nodes.indices.filter { nodes[$0].group == p.group.id && nodes[$0].kind != "group" } }
    // columns per box: proportional to its node count, at least 1, filling the canvas width
    let avail = graphWidth - 32 - gap * Double(row.count - 1)
    let maxCols = max(1, Int(avail / cellW))
    var cols = members.map { max(1, min($0.count, 3)) }
    while cols.reduce(0, +) > maxCols, let i = cols.indices.max(by: { cols[$0] < cols[$1] }), cols[i] > 1 { cols[i] -= 1 }
    let unit = avail / Double(cols.reduce(0, +))
    let rowsIn = zip(members, cols).map { max(1, ($0.0.count + $0.1 - 1) / $0.1) }
    let h = 30 + Double(rowsIn.max() ?? 1) * cellH + 6
    var x = 16.0
    for (k, p) in row.enumerated() {
      let w = unit * Double(cols[k])
      let b = boxes.firstIndex { $0.id == p.group.id }!
      boxes[b].x = x; boxes[b].y = y; boxes[b].w = w; boxes[b].h = h
      let cw = w / Double(cols[k])
      for (j, i) in members[k].enumerated() {
        nodes[i].x = x + cw * (Double(j % cols[k]) + 0.5)
        nodes[i].y = y + 30 + cellH * Double(j / cols[k]) + 18
        nodes[i].r = nodes[i].kind == "more" ? 12 : 10
      }
      x += w + gap
    }
    y += h + gap
    start += maxPerRow
  }
  let height = max(bubblesHeight, y)
  // centre the rows vertically when they don't fill the canvas
  let shift = (height - y) / 2
  if shift > 0 {
    for i in nodes.indices { nodes[i].y += shift }
    for i in boxes.indices { boxes[i].y += shift }
  }
  return (graphWidth, height)
}

/// Arc list: one row per closed group, a header row then one row per node for an opened group. Arcs live left of
/// `listGutter`.
let listGutter = 170.0
let listRow = 28.0
private func layoutList(_ nodes: inout [GraphNode], _ boxes: inout [GraphBox], _ placed: [Placed]) -> (Double, Double) {
  var idx: [String: Int] = [:]
  for (i, n) in nodes.enumerated() { idx[n.id] = i }
  var y = 14.0 + listRow / 2
  for p in placed {
    if !p.open {
      let i = idx[p.group.id]!
      nodes[i].x = listGutter; nodes[i].y = y; nodes[i].r = listRow / 2 - 2
      y += listRow + 4
      continue
    }
    let b = boxes.firstIndex { $0.id == p.group.id }!
    boxes[b].x = listGutter; boxes[b].y = y; boxes[b].w = graphWidth - listGutter - 8; boxes[b].h = listRow
    y += listRow
    for i in nodes.indices where nodes[i].group == p.group.id && nodes[i].kind != "group" {
      nodes[i].x = listGutter; nodes[i].y = y; nodes[i].r = listRow / 2 - 3
      y += listRow - 2
    }
    y += 8
  }
  return (graphWidth, max(y + 6, 120))
}

// MARK: B3 sequence

/// Approvals and turns in time order, never message text. With the bridge's `turn_log` every turn is one arrow from
/// whoever took it; without it (an older bridge) the turns collapse into one row "12 turns · 09:12–10:30".
func sequenceEvents(_ c: Snapshot.Conversation, clock: Clock) -> [SeqEvent] {
  var items: [(Date?, Int, SeqEvent)] = []
  var n = 0
  func add(_ d: Date?, _ e: SeqEvent) { items.append((d, n, e)); n += 1 }
  func side(_ address: String?) -> String { address == c.to ? "to" : "from" }

  for a in c.approvals ?? [] {
    let human = a.via == "prompt" || a.via == "cli"
    add(Clock.parse(a.at), SeqEvent(kind: "approval", side: side(a.agent), label: (human ? "✓ " : "") + approvalText(a), time: clock.hm(a.at), human: human))
  }
  let used = c.turns?.used ?? 0
  let log = (c.turn_log ?? []).filter { $0.at != nil }
  if !log.isEmpty {
    let earlier = used - log.count
    let firstAt = Clock.parse(log[0].at)
    if earlier > 0 {
      add(firstAt.map { $0.addingTimeInterval(-0.001) }, SeqEvent(kind: "turns", side: "both", label: "\(earlier) earlier turn\(earlier == 1 ? "" : "s")", time: nil, human: false))
    }
    for (k, t) in log.enumerated() {
      let num = t.turn ?? (earlier + k + 1)
      add(Clock.parse(t.at), SeqEvent(kind: "turn", side: side(t.from), label: "turn \(num)", time: clock.hm(t.at), human: false))
    }
  } else if used > 0 {
    let start = clock.hm(c.started_at), last = clock.hm(c.last_activity_at)
    let range = [start, last].compactMap { $0 }
    let span = range.count == 2 && range[0] != range[1] ? " · \(range[0])–\(range[1])" : ""
    // just after the opening approvals: they happen before the first turn
    let at = Clock.parse(c.started_at).map { d -> Date in
      let opening = (c.approvals ?? []).filter { $0.kind != "extend" }.compactMap { Clock.parse($0.at) }.max()
      return max(d, opening ?? d).addingTimeInterval(0.001)
    }
    add(at, SeqEvent(kind: "turns", side: "both", label: "\(used) turn\(used == 1 ? "" : "s")\(span)", time: nil, human: false))
  }
  if c.state == "ended" {
    let why = c.end_reason.map { endReasons[$0] ?? $0 }
    let at = c.ended_at ?? c.last_activity_at
    add(Clock.parse(at).map { $0.addingTimeInterval(0.002) }, SeqEvent(kind: "end", side: "both", label: "Ended" + (why.map { " · \($0)" } ?? ""), time: clock.hm(at), human: false))
  } else if c.state == "pending" {
    add(nil, SeqEvent(kind: "end", side: "both", label: c.queued == true ? "Waits for \(displayName(c.to)) to open" : "Waiting for \(displayName(c.to)) to accept", time: nil, human: false))
  }
  return items.sorted { x, y in
    switch (x.0, y.0) {
    case let (a?, b?): return a != b ? a < b : x.1 < y.1
    case (nil, nil): return x.1 < y.1
    case (nil, _): return false
    case (_, nil): return true
    }
  }.map { $0.2 }
}
