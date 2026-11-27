// Agent panel, step B: the graph window. Opens from the dropdown's "Window" button (⌘O). Same PanelStore, same
// `status --watch --json` stream; layout and merging come from GraphModel.swift.
//
// Left: B1 bubbles, or B2's arc list when there are too many visible nodes (or when picked). Right: a side pane with
// the overview, a merged line's conversations, an agent or group, or a conversation's B3 sequence view.
// Read-only: no Approve or Decline, no message text, no Touch ID. Approvals stay in each agent's own prompt.
import AppKit
import SwiftUI

enum GraphSelection: Equatable {
  case none
  case edge(String)
  /// A conversation, and the merged line it was picked from (for the back button).
  case conversation(String, from: String?)
  case node(String)
}

/// What the window remembers while it is open: opened groups, the filter, the selection. Shared by the window's content
/// and its toolbar items, which are separate views.
final class GraphUI: ObservableObject {
  /// Opened groups per grouping; absent means automatic.
  @Published var expanded: [String: Set<String>] = [:]
  @Published var showAll: Set<String> = []
  @Published var query = ""
  @Published var selection: GraphSelection = .none
  /// Bubbles: zoom (1 = the graph fits the window) and pan, in points.
  @Published var zoom: Double = 1
  @Published var pan: CGSize = .zero
  /// The chip being dragged and where (ring coordinates); saved to the defaults when dropped.
  @Published var dragging: [String: [Double]] = [:]
  /// What zooming around a point needs, noted by the canvas as it lays out (not published: no redraw).
  private(set) var viewport: CGSize = .zero
  private var fit = 1.0, graphSize = CGSize(width: 1, height: 1)
  /// The bubbles' fit for a graph of this size in the current viewport (same rule as the canvas).
  func fitFor(_ g: GraphModel) -> Double {
    let cap = g.boxes.isEmpty ? 1.1 : 1.4
    return min(cap, max(0.55, min((viewport.width - 24) / g.width, (viewport.height - 24) / g.height)))
  }
  static let zoomRange = 0.3...4.0

  func noteLayout(viewport: CGSize, fit: Double, graph: CGSize) -> Bool {
    self.viewport = viewport; self.fit = fit; self.graphSize = graph; return true
  }
  /// Zooms keeping the graph point under `point` (canvas coordinates; nil: the centre) where it is.
  func zoomTo(_ z: Double, at point: CGPoint? = nil) {
    let z1 = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, z))
    let c = CGPoint(x: viewport.width / 2, y: viewport.height / 2), pt = point ?? c
    let s0 = fit * zoom, s1 = fit * z1
    let ox = c.x + pan.width - graphSize.width * s0 / 2, oy = c.y + pan.height - graphSize.height * s0 / 2
    let gx = (pt.x - ox) / s0, gy = (pt.y - oy) / s0
    pan = CGSize(width: pt.x - gx * s1 - c.x + graphSize.width * s1 / 2, height: pt.y - gy * s1 - c.y + graphSize.height * s1 / 2)
    zoom = z1
  }
  func zoomBy(_ factor: Double, at point: CGPoint? = nil) { zoomTo(zoom * factor, at: point) }
  func resetView() { zoom = 1; pan = .zero }
}

/// How much the bubbles show at a zoom: dots with counts when zoomed out, today's chips, agent cards when zoomed in.
enum ZoomLevel {
  case dots, chips, cards
  init(_ zoom: Double) { self = zoom < 0.6 ? .dots : zoom >= 1.5 ? .cards : .chips }
}

/// "bubbles" | "list" (an older "auto" reads as bubbles).
func layoutChoice(_ stored: String) -> String { stored == "list" ? "list" : "bubbles" }

/// Where moved chips are kept (one JSON string, per grouping); "Reset layout" clears the current grouping's.
let chipSpotsKey = "agentPanel.chipPositions"
func decodeChipSpots(_ s: String) -> [String: [String: [Double]]] {
  (try? JSONDecoder().decode([String: [String: [Double]]].self, from: Data(s.utf8))) ?? [:]
}
func encodeChipSpots(_ v: [String: [String: [Double]]]) -> String {
  let e = JSONEncoder(); e.outputFormatting = .sortedKeys
  return (try? e.encode(v)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}
func resetChipSpots(_ s: String, groupBy: String) -> String { var all = decodeChipSpots(s); all[groupBy] = nil; return encodeChipSpots(all) }

struct GraphWindowView: View {
  @ObservedObject var store: PanelStore
  @ObservedObject var ui: GraphUI
  @AppStorage private var groupBy: String          // shared with the dropdown
  @AppStorage private var layoutPick: String       // "bubbles" | "list"
  @AppStorage private var appearance: String       // "system" | "light" | "dark"
  @State private var dragStart: CGSize? = nil
  /// Chips the person moved, per grouping: {"project": {"<group id>": [x, y]}, "app": {…}} (ring coordinates).
  @AppStorage private var chipSpots: String
  let defaults: UserDefaults
  /// The toolbar lives in the window's title bar as toolbar items (false for off-screen renders: drawn inline).
  let inTitleBar: Bool

  init(store: PanelStore, ui: GraphUI, defaults: UserDefaults = .standard, options: GraphOptions? = nil, selection: GraphSelection? = nil, inTitleBar: Bool = false) {
    self.store = store; self.ui = ui; self.defaults = defaults; self.inTitleBar = inTitleBar
    _groupBy = AppStorage(wrappedValue: "project", "agentPanel.groupBy", store: defaults)
    _layoutPick = AppStorage(wrappedValue: "bubbles", "agentPanel.windowLayout", store: defaults)
    _appearance = AppStorage(wrappedValue: "system", "agentPanel.windowAppearance", store: defaults)
    _chipSpots = AppStorage(wrappedValue: "{}", chipSpotsKey, store: defaults)
    if let o = options {
      if let x = o.expanded { ui.expanded[o.groupBy] = x }
      ui.showAll = o.showAll; ui.query = o.query
    }
    if let selection { ui.selection = selection }
  }

  var m: PanelModel { store.model }
  var options: GraphOptions {
    var o = GraphOptions(groupBy: groupBy, expanded: ui.expanded[groupBy], showAll: ui.showAll, layout: layoutChoice(layoutPick), query: ui.query)
    o.positions = decodeChipSpots(chipSpots)[groupBy] ?? [:]
    o.dragging = ui.dragging
    return o
  }

  /// A chip dragged to `p` (ring coordinates); `done`: dropped, so save it. The canvas may grow to take it in: the
  /// pan moves by the same amount, so nothing on screen jumps.
  private func moveChip(_ id: String, _ p: [Double], done: Bool) {
    guard done else { ui.dragging[id] = p; return }
    let before = buildGraph(m, options)
    var all = decodeChipSpots(chipSpots)
    all[groupBy, default: [:]][id] = p
    chipSpots = encodeChipSpots(all)
    ui.dragging = [:]
    let after = buildGraph(m, options)
    let sb = ui.fitFor(before) * ui.zoom, sa = ui.fitFor(after) * ui.zoom
    ui.pan.width += (before.originX - before.width / 2) * sb - (after.originX - after.width / 2) * sa
    ui.pan.height += (before.originY - before.height / 2) * sb - (after.originY - after.height / 2) * sa
  }

  var body: some View {
    let graph = buildGraph(m, options)
    VStack(spacing: 0) {
      // the real window puts these in its title bar as accessory views (GraphWindowController); renders draw them here
      if !inTitleBar {
        HStack(spacing: 14) {
          GraphToolbar(store: store, ui: ui, defaults: defaults, part: .left)
          Spacer(minLength: 8)
          GraphToolbar(store: store, ui: ui, defaults: defaults, part: .right)
        }
        .padding(.horizontal, 14).frame(height: 42)
        .background(GraphPalette.chrome, ignoresSafeAreaEdges: [])
      }
      Divider()
      if m.status == "ok" {
        HStack(spacing: 0) {
          canvas(graph)
          Divider()
          SidePane(model: m, graph: graph, groups: groupBy == "app" ? m.byApp : m.byProject, selection: $ui.selection,
                   toggleGroup: { toggle($0, graph) })
            .frame(width: 380)
            .background(GraphPalette.chrome, ignoresSafeAreaEdges: [])
        }
      } else {
        StateCard(model: m).frame(maxWidth: 460).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      }
    }
    .frame(minWidth: 820, minHeight: 480)
    .font(.system(size: 12.5))
    .onChange(of: groupBy) { _ in ui.selection = .none; ui.resetView() }
    .onChange(of: layoutPick) { _ in ui.resetView() }
    .background(WindowAppearance(mode: appearance))
  }

  private func toggle(_ id: String, _ graph: GraphModel) {
    var set = ui.expanded[groupBy] ?? Set(graph.expanded)
    if set.contains(id) { set.remove(id) } else { set.insert(id) }
    ui.expanded[groupBy] = set
  }

  /// Bubbles: pinch or ⌘-scroll to zoom, scroll or drag the empty canvas to pan, ⌘+ ⌘− ⌘0, the controls bottom right.
  private func bubbles(_ graph: GraphModel) -> some View {
    GeometryReader { geo in
      let pad = 12.0
      // chips keep their size while positions scale, so a chips-only graph never fits above 1.1: a big window would
      // otherwise just stretch the gaps between them
      let cap = graph.boxes.isEmpty ? 1.1 : 1.4
      let fit = min(cap, max(0.55, min((geo.size.width - 2 * pad) / graph.width, (geo.size.height - 2 * pad) / graph.height)))
      let s = fit * ui.zoom
      let _ = ui.noteLayout(viewport: geo.size, fit: fit, graph: CGSize(width: graph.width, height: graph.height))
      ZStack {
        Color.clear.contentShape(Rectangle())
          .gesture(DragGesture(minimumDistance: 2)
            .onChanged { v in
              let start = dragStart ?? ui.pan
              if dragStart == nil { dragStart = start }
              ui.pan = CGSize(width: start.width + v.translation.width, height: start.height + v.translation.height)
            }
            .onEnded { _ in dragStart = nil })
        GraphCanvas(graph: graph, model: m, s: s, selection: $ui.selection,
                    tapGroup: { toggle($0, graph) },
                    tapMore: { ui.showAll.insert($0) },
                    tapEdge: { e in
                      ui.selection = e.conversations.count == 1 ? .conversation(e.conversations[0], from: nil) : .edge(e.id)
                    },
                    level: ZoomLevel(ui.zoom), zoom: ui.zoom, groups: groupBy == "app" ? m.byApp : m.byProject,
                    moveChip: { id, p, done in moveChip(id, p, done: done) })
          .frame(width: graph.width * s, height: graph.height * s)
          .offset(ui.pan)
      }
      .frame(width: geo.size.width, height: geo.size.height)
      .clipped()
      .background(ScrollZoomCatcher(
        onScroll: { dx, dy in ui.pan = CGSize(width: ui.pan.width + dx, height: ui.pan.height + dy) },
        onZoom: { f, pt in ui.zoomBy(f, at: pt) }))
    }
    .background(DotGrid())
    .overlay(alignment: .bottomLeading) { GraphLegend().padding(10) }
    .overlay(alignment: .bottomTrailing) {
      ZoomControls(ui: ui, moved: !(decodeChipSpots(chipSpots)[groupBy] ?? [:]).isEmpty,
                   resetLayout: { chipSpots = resetChipSpots(chipSpots, groupBy: groupBy) }).padding(10)
    }
  }

  private func canvas(_ graph: GraphModel) -> some View {
    Group { if graph.layout == "bubbles" { bubbles(graph) } else { listCanvas(graph) } }
  }

  private func listCanvas(_ graph: GraphModel) -> some View {
    GeometryReader { geo in
      let pad = 12.0
      let fitW = (geo.size.width - 2 * pad) / graph.width
      let fitH = (geo.size.height - 2 * pad) / graph.height
      let s = min(1.4, max(0.55, graph.layout == "bubbles" ? min(fitW, fitH) : fitW))
      ScrollView([.vertical, .horizontal]) {
        GraphCanvas(graph: graph, model: m, s: s, selection: $ui.selection,
                    tapGroup: { toggle($0, graph) },
                    tapMore: { ui.showAll.insert($0) },
                    tapEdge: { e in
                      ui.selection = e.conversations.count == 1 ? .conversation(e.conversations[0], from: nil) : .edge(e.id)
                    })
          .frame(width: graph.width * s, height: graph.height * s)
          .padding(pad)
          .frame(minWidth: geo.size.width, minHeight: geo.size.height)
      }
    }
    .background(DotGrid())
    .overlay(alignment: .bottomLeading) { GraphLegend().padding(10) }
  }
}

// MARK: palette (light: "Cream + ink", dark: "Night"; follows the macOS appearance)

extension NSColor {
  static func ab(light: UInt32, dark: UInt32) -> NSColor {
    func c(_ v: UInt32) -> NSColor { NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1) }
    return NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? c(dark) : c(light) }
  }
}

/// The graph canvas's own colours. Light: a cream canvas with deep ink-blue lines; dark: graphite with a brighter sky.
/// Coral (needs you) keeps its meaning in both.
enum GraphPalette {
  static let canvas = Color(nsColor: .ab(light: 0xF6F1E6, dark: 0x17191D))
  /// The title bar and side pane: the canvas's family, one step lighter (cream in light, cool graphite in dark).
  static let chromeNS = NSColor.ab(light: 0xFBF8F1, dark: 0x1D2026)
  static let chrome = Color(nsColor: chromeNS)
  static let dots = Color(nsColor: .ab(light: 0xE5DCC9, dark: 0x262A30))
  static let chip = Color(nsColor: .ab(light: 0xFFFFFF, dark: 0x262A31))
  static let needChip = Color(nsColor: .ab(light: 0xFCEDE6, dark: 0x3A2320))
  static let border = Color(nsColor: .ab(light: 0xE3D8C3, dark: 0x353A43))
  static let line = Color(nsColor: .ab(light: 0x2B5C94, dark: 0x4FA8F5))
  static let idle = Color(nsColor: .ab(light: 0xC2B8A6, dark: 0x5A616C))
}

/// The canvas background: the palette's colour with a faint dot grid.
struct DotGrid: View {
  var body: some View {
    Canvas { ctx, size in
      ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(GraphPalette.canvas))
      var dots = Path()
      for x in stride(from: 9.0, to: size.width, by: 18) {
        for y in stride(from: 9.0, to: size.height, by: 18) { dots.addEllipse(in: CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)) }
      }
      ctx.fill(dots, with: .color(GraphPalette.dots))
    }
  }
}

/// Trackpad and mouse input over the bubbles: scroll pans, pinch (or ⌘-scroll) zooms around the pointer. A local
/// event monitor rather than a view in front, so clicks still reach the chips and lines.
struct ScrollZoomCatcher: NSViewRepresentable {
  var onScroll: (CGFloat, CGFloat) -> Void
  var onZoom: (Double, CGPoint) -> Void

  final class CatcherView: NSView {
    var onScroll: ((CGFloat, CGFloat) -> Void)?
    var onZoom: ((Double, CGPoint) -> Void)?
    private var monitor: Any?
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
      guard window != nil else { return }
      monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .magnify]) { [weak self] e in
        guard let self, let w = self.window, e.window === w else { return e }
        let p = self.convert(e.locationInWindow, from: nil)
        guard self.bounds.contains(p) else { return e }
        if e.type == .magnify { self.onZoom?(1 + Double(e.magnification), p); return nil }
        if e.modifierFlags.contains(.command) {
          self.onZoom?(exp(Double(e.scrollingDeltaY) * (e.hasPreciseScrollingDeltas ? 0.01 : 0.1)), p); return nil
        }
        let k: CGFloat = e.hasPreciseScrollingDeltas ? 1 : 12
        self.onScroll?(e.scrollingDeltaX * k, e.scrollingDeltaY * k)
        return nil
      }
    }
    deinit { if let m = monitor { NSEvent.removeMonitor(m) } }
  }
  func makeNSView(context: Context) -> CatcherView { CatcherView() }
  func updateNSView(_ v: CatcherView, context: Context) { v.onScroll = onScroll; v.onZoom = onZoom }
}

/// Bottom right of the bubbles: − 100% + and fit.
struct ZoomControls: View {
  @ObservedObject var ui: GraphUI
  /// Some chip in this grouping was moved: show "Reset layout".
  var moved = false
  var resetLayout: () -> Void = {}
  var body: some View {
    HStack(spacing: 0) {
      if moved {
        button("arrow.counterclockwise", "Reset layout", "puts every chip back") { resetLayout() }
        Divider().frame(height: 14).padding(.horizontal, 2)
      }
      button("minus", "Zoom out", "⌘−") { ui.zoomBy(1 / 1.25) }
      Text("\(Int((ui.zoom * 100).rounded()))%").font(.system(size: 11)).monospacedDigit().frame(width: 42)
        .accessibilityLabel("Zoom \(Int((ui.zoom * 100).rounded())) percent")
        .contentShape(Rectangle()).onTapGesture { withAnimation(.easeOut(duration: 0.15)) { ui.resetView() } }
        .help("Fit everything (⌘0)")
      button("plus", "Zoom in", "⌘+") { ui.zoomBy(1.25) }
      Divider().frame(height: 14).padding(.horizontal, 2)
      button("arrow.up.left.and.arrow.down.right", "Fit everything", "⌘0") { ui.resetView() }
    }
    .foregroundColor(.secondary)
    .padding(.horizontal, 3).frame(height: 26)
    .background(RoundedRectangle(cornerRadius: 7).fill(GraphPalette.chip.opacity(0.95)))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(GraphPalette.border))
  }
  func button(_ icon: String, _ name: String, _ key: String, _ action: @escaping () -> Void) -> some View {
    Button { withAnimation(.easeOut(duration: 0.15)) { action() } } label: {
      Image(systemName: icon).font(.system(size: 10.5, weight: .semibold)).frame(width: 24, height: 24).contentShape(Rectangle())
    }
    .buttonStyle(.plain).help("\(name) (\(key))").accessibilityLabel(name)
  }
}

/// The window's toolbar, in two parts so each can be its own title-bar toolbar item: left (grouping tabs, layout
/// icons) and right (counts, what needs you, the filter, appearance).
struct GraphToolbar: View {
  enum Part { case left, right }
  @ObservedObject var store: PanelStore
  @ObservedObject var ui: GraphUI
  @AppStorage private var groupBy: String
  @AppStorage private var layoutPick: String
  @AppStorage private var appearance: String
  let part: Part

  init(store: PanelStore, ui: GraphUI, defaults: UserDefaults, part: Part) {
    self.store = store; self.ui = ui; self.part = part
    _groupBy = AppStorage(wrappedValue: "project", "agentPanel.groupBy", store: defaults)
    _layoutPick = AppStorage(wrappedValue: "bubbles", "agentPanel.windowLayout", store: defaults)
    _appearance = AppStorage(wrappedValue: "system", "agentPanel.windowAppearance", store: defaults)
  }

  var body: some View {
    let m = store.model
    switch part {
    case .left:
      HStack(spacing: 14) {
        HStack(spacing: 16) {
          UnderlineTab(title: "By project", on: groupBy == "project") { groupBy = "project" }
          UnderlineTab(title: "By app", on: groupBy == "app") { groupBy = "app" }
        }
        IconSegment(selection: Binding(get: { layoutChoice(layoutPick) }, set: { layoutPick = $0 }), items: [
          ("bubbles", "circle.hexagongrid", "Bubbles"),
          ("list", "list.bullet", "List"),
        ])
      }
      .fixedSize()
    case .right:
      let graph = buildGraph(m, GraphOptions(groupBy: groupBy, expanded: ui.expanded[groupBy], showAll: ui.showAll, layout: layoutChoice(layoutPick), query: ui.query))
      HStack(spacing: 14) {
        if m.status == "ok" {
          Text("\(graph.visibleNodes) node\(graph.visibleNodes == 1 ? "" : "s") · \(m.live.count) live")
            .font(.system(size: 11)).foregroundColor(.secondary).lineLimit(1)
        }
        if m.iconCount > 0 {
          Button { ui.selection = .none } label: {
            HStack(spacing: 5) { Diamond(color: .abNeed, size: 7); Text("\(m.iconCount) need\(m.iconCount == 1 ? "s" : "") you") }
              .font(.system(size: 11.5)).foregroundColor(.abNeed).lineLimit(1)
          }
          .buttonStyle(.plain)
          .help("Listed in the side pane. Answer in each agent's own prompt.")
        }
        HStack(spacing: 5) {
          Image(systemName: "magnifyingglass").font(.system(size: 10)).foregroundColor(.secondary)
          TextField("Filter", text: $ui.query).textFieldStyle(.plain).font(.system(size: 11.5)).frame(width: 140)
        }
        .padding(.horizontal, 7).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.06)))
        AppearanceButton(mode: $appearance)
      }
      .fixedSize()
    }
  }
}

/// "By project" / "By app": underline tabs, as in the dropdown's Conversations | Agents.
struct UnderlineTab: View {
  let title: String; let on: Bool; let action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 4) {
        Text(title).font(.system(size: 12.5, weight: on ? .semibold : .regular)).foregroundColor(on ? .primary : .secondary)
        Capsule().fill(on ? Color.primary : Color.clear).frame(height: 2)
      }
      .fixedSize().padding(.top, 5).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(on ? [.isSelected] : [])
  }
}

/// A small group of icon buttons; the chosen one gets a neutral raised background (no accent colour).
struct IconSegment: View {
  @Binding var selection: String
  let items: [(String, String, String)]   // tag, SF Symbol, tooltip
  var body: some View {
    HStack(spacing: 2) {
      ForEach(items, id: \.0) { item in
        let on = selection == item.0
        Button { selection = item.0 } label: {
          Image(systemName: item.1).font(.system(size: 12, weight: .medium)).foregroundColor(on ? .primary : .secondary)
            .frame(width: 26, height: 20)
            .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.primary.opacity(0.14) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(item.2).accessibilityLabel(item.2)
        .accessibilityAddTraits(on ? [.isSelected] : [])
      }
    }
    .padding(2)
    .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.06)))
  }
}

/// One button that cycles: follow the Mac → light → dark.
struct AppearanceButton: View {
  @Binding var mode: String
  var body: some View {
    let (icon, label, next): (String, String, String) = mode == "light" ? ("sun.max", "Light", "dark")
      : mode == "dark" ? ("moon", "Dark", "system") : ("circle.lefthalf.filled", "Follows the Mac", "light")
    Button { mode = next } label: {
      Image(systemName: icon).font(.system(size: 12, weight: .medium)).foregroundColor(.secondary)
        .frame(width: 26, height: 22)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.06)))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Appearance: \(label). Click to switch.")
    .accessibilityLabel("Appearance: \(label)")
  }
}

/// Sets the window's own appearance: light or dark whatever the Mac uses, or nil to follow it again.
struct WindowAppearance: NSViewRepresentable {
  let mode: String
  func makeNSView(context: Context) -> NSView { NSView() }
  func updateNSView(_ view: NSView, context: Context) {
    let a: NSAppearance? = mode == "light" ? NSAppearance(named: .aqua) : mode == "dark" ? NSAppearance(named: .darkAqua) : nil
    DispatchQueue.main.async { view.window?.appearance = a }   // the view joins its window after this call
  }
}

// MARK: canvas

struct GraphCanvas: View {
  let graph: GraphModel
  let model: PanelModel
  let s: Double
  @Binding var selection: GraphSelection
  let tapGroup: (String) -> Void
  let tapMore: (String) -> Void
  let tapEdge: (GraphEdge) -> Void
  /// Bubbles only: what the zoom shows (the list always draws `.chips`).
  var level: ZoomLevel = .chips
  var zoom: Double = 1
  /// The groups as the model has them (same grouping): the agents a zoomed-in chip opens into.
  var groups: [AgentGroup] = []
  /// Dragging a chip (the ring layout only): reports its new ring coordinates, `true` when dropped.
  var moveChip: ((String, [Double], Bool) -> Void)? = nil
  /// Zoomed in: the conversation line under the pointer (it and its two agents light up, the rest fade).
  @State private var hoverLine: String? = nil
  /// Where each chip being dragged started, in ring coordinates.
  @State private var chipDragStart: [String: CGPoint] = [:]

  /// The movable chip under the pointer: a chip at 100%, a dot zoomed out, an opened card stack zoomed in.
  func chipAt(_ pt: CGPoint) -> String? {
    if lvl == .cards {
      for (id, st) in cardStacks() where abs(pt.x - st.c.x) <= Self.cardW / 2 && abs(pt.y - st.c.y) <= st.h / 2 { return id }
      return nil
    }
    for n in graph.nodes where n.kind == "group" {
      let dx = abs(pt.x - n.x * s), dy = abs(pt.y - n.y * s)
      if lvl == .dots ? (dx * dx + dy * dy).squareRoot() <= 16 : (dx <= n.w / 2 && dy <= n.h / 2) { return n.id }
    }
    return nil
  }

  /// Drag a group chip (at any zoom) to move it; its spot is saved when dropped. A click without movement still opens
  /// or selects as before.
  func chipDrag(_ n: GraphNode) -> some Gesture {
    DragGesture(minimumDistance: 4)
      .onChanged { v in
        guard graph.movable, let move = moveChip else { return }
        let start = chipDragStart[n.id] ?? CGPoint(x: n.x - graph.originX, y: n.y - graph.originY)
        if chipDragStart[n.id] == nil { chipDragStart[n.id] = start }
        NSCursor.closedHand.set()
        move(n.id, [start.x + v.translation.width / s, start.y + v.translation.height / s], false)
      }
      .onEnded { v in
        guard graph.movable, let move = moveChip, let start = chipDragStart[n.id] else { return }
        chipDragStart[n.id] = nil
        NSCursor.openHand.set()
        move(n.id, [start.x + v.translation.width / s, start.y + v.translation.height / s], true)
      }
  }

  var nodeIndex: [String: GraphNode] { Dictionary(uniqueKeysWithValues: graph.nodes.map { ($0.id, $0) }) }
  var list: Bool { graph.layout == "list" }

  func selectedEdge(_ e: GraphEdge) -> Bool {
    switch selection {
    case .edge(let id): return id == e.id
    case .conversation(let c, _): return e.conversations.contains(c)
    default: return false
    }
  }

  var lvl: ZoomLevel { list ? .chips : level }

  var body: some View {
    let idx = nodeIndex
    ZStack(alignment: .topLeading) {
      ForEach(graph.boxes) { b in boxView(b) }
      if lvl == .cards {
        let stacks = cardStacks()
        let anchors = cardAnchors(stacks)
        let lines = cardLines(model.live).filter { anchors[$0.from] != nil && anchors[$0.to] != nil }
        let pills = placeCardLabels(lines, anchors)
        let ends = Set(lines.first { $0.id == hoverLine }.map { [$0.from, $0.to] } ?? [])
        ForEach(lines) { l in cardLineView(l, anchors).zIndex(l.id == hoverLine ? 1 : 0) }
        ForEach(graph.nodes) { n in cardNodeView(n, stacks, ends: ends).zIndex(2) }
        ForEach(lines) { l in cardLineLabel(l, pills[l.id]).zIndex(l.id == hoverLine ? 4 : 3) }
      } else {
        ForEach(graph.edges) { e in edgeView(e, idx).zIndex(e.id == hoverLine ? 1 : 0) }
        ForEach(graph.nodes) { n in nodeView(n).zIndex(2) }
        if lvl == .chips {
          let labels = placeLabels(idx)
          ForEach(graph.edges) { e in edgeLabel(e, labels[e.id]).zIndex(e.id == hoverLine ? 4 : 3) }
        }
      }
    }
    .frame(width: graph.width * s, height: graph.height * s, alignment: .topLeading)
    .animation(.easeInOut(duration: 0.18), value: lvl)
    .animation(.easeOut(duration: 0.12), value: hoverLine)
    // zoomed in, hover tracking over the whole canvas: the curves and pills are hit-tested here (a path view's hover
    // area is its whole frame, so per-line onHover would light every line at once)
    .onContinuousHover { phase in
      guard !list else { return }
      var hit: String? = nil, overChip = false
      if case .active(let pt) = phase {
        // a chip that can be dragged takes the pointer (open hand); lines only light up off the chips
        overChip = graph.movable && moveChip != nil && chipAt(pt) != nil
        if overChip || lvl == .dots {
        } else if lvl == .cards {
          let anchors = cardAnchors(cardStacks())
          let lines = cardLines(model.live).filter { anchors[$0.from] != nil && anchors[$0.to] != nil }
          hit = hitCardLine(pt, lines, anchors, placeCardLabels(lines, anchors))
        } else {
          hit = hitEdge(pt, nodeIndex)
        }
      }
      if hit != hoverLine { hoverLine = hit }
      if !chipDragStart.isEmpty { NSCursor.closedHand.set() }
      else { (overChip ? NSCursor.openHand : hit != nil ? NSCursor.pointingHand : NSCursor.arrow).set() }
    }
    .onChange(of: lvl) { _ in hoverLine = nil }
  }

  // geometry

  func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * s, y: y * s) }

  /// How far an arc reaches left of the gutter: even neighbouring rows get a visible arc, longer arcs reach further.
  func bulge(_ y1: Double, _ y2: Double) -> Double { min(160, abs(y2 - y1) * 0.45 + 40) }

  func edgePath(_ e: GraphEdge, _ idx: [String: GraphNode], offset: Double = 0) -> Path? {
    guard let a = idx[e.a], let b = idx[e.b] else { return nil }
    var path = Path()
    if list {
      if e.inside { return nil }   // the row says "↺ N internal convo" after the group's name instead
      let (y1, y2) = a.y < b.y ? (a.y, b.y) : (b.y, a.y)
      let k = bulge(y1, y2) * (1 - offset * 0.08)
      path.move(to: p(a.x, y1)); path.addCurve(to: p(a.x, y2), control1: p(a.x - k, y1), control2: p(a.x - k, y2))
      return path
    }
    if e.inside { return nil }
    let (A, B) = ends(e, a, b, ports)
    let (c, n) = control(A, B)
    path.move(to: p(A.0 + n.0 * offset, A.1 + n.1 * offset))
    path.addQuadCurve(to: p(B.0 + n.0 * offset, B.1 + n.1 * offset), control: p(c.0 + n.0 * offset, c.1 + n.1 * offset))
    return path
  }

  /// Bubbles draw lines as gentle curves, so a line between two nodes in one column bends around the nodes between
  /// them instead of running through them. Bends to the right for steep lines, upwards for flat ones. Returns the
  /// control point and the unit normal.
  func control(_ a: (Double, Double), _ b: (Double, Double)) -> ((Double, Double), (Double, Double)) {
    let dx = b.0 - a.0, dy = b.1 - a.1, len = max(1, (dx * dx + dy * dy).squareRoot())
    var nx = -dy / len, ny = dx / len
    if abs(dy) > abs(dx) ? nx < 0 : ny > 0 { nx = -nx; ny = -ny }
    // with boxes on the canvas, lines bend more so they clear the agent dots and labels in between
    let k = graph.boxes.isEmpty ? 0.28 * len * min(1, abs(dy) / max(abs(dx), 1) * 0.5 + 0.25) : 0.3 * len
    return (((a.0 + b.0) / 2 + nx * k, (a.1 + b.1) / 2 + ny * k), (nx, ny))
  }

  /// Lines leaving one node in nearly the same direction start side by side (12 pt apart, in angle order so they
  /// don't cross) instead of from one point, so they and their arrowheads don't pile up. Offsets in points, per node
  /// and line.
  var ports: [String: [String: Double]] {
    var out: [String: [String: Double]] = [:]
    let idx = nodeIndex
    var around: [String: [(String, Double)]] = [:]
    for e in graph.edges where !e.inside {
      guard let a = idx[e.a], let b = idx[e.b] else { continue }
      around[a.id, default: []].append((e.id, atan2(b.y - a.y, b.x - a.x)))
      around[b.id, default: []].append((e.id, atan2(a.y - b.y, a.x - b.x)))
    }
    for (node, list) in around {
      let sorted = list.sorted { $0.1 < $1.1 }
      var clusters: [[String]] = []
      var last = -Double.infinity
      for (id, ang) in sorted {
        if ang - last < 0.5, !clusters.isEmpty { clusters[clusters.count - 1].append(id) } else { clusters.append([id]) }
        last = ang
      }
      for c in clusters where c.count > 1 {
        for (i, id) in c.enumerated() { out[node, default: [:]][id] = (Double(i) - Double(c.count - 1) / 2) * 12 }
      }
    }
    return out
  }

  /// A line's two ends in model units, moved sideways to their ports.
  func ends(_ e: GraphEdge, _ a: GraphNode, _ b: GraphNode, _ ports: [String: [String: Double]]) -> ((Double, Double), (Double, Double)) {
    func shifted(_ n: GraphNode, toward o: GraphNode) -> (Double, Double) {
      guard let off = ports[n.id]?[e.id], off != 0 else { return (n.x, n.y) }
      let dx = o.x - n.x, dy = o.y - n.y, len = max(1, (dx * dx + dy * dy).squareRoot())
      // perpendicular, turning the same way as increasing angle; capped so a chip's ports stay on the chip
      var px = -dy / len * off / s, py = dx / len * off / s
      if n.w > 0 { px = max(-(n.w / 2 - 12) / s, min((n.w / 2 - 12) / s, px)); py = max(-(n.h / 2 - 6) / s, min((n.h / 2 - 6) / s, py)) }
      return (n.x + px, n.y + py)
    }
    return (shifted(a, toward: b), shifted(b, toward: a))
  }

  /// Every line's count pill, placed one after another so a pill also keeps clear of the pills placed before it.
  func placeLabels(_ idx: [String: GraphNode]) -> [String: CGPoint] {
    var out: [String: CGPoint] = [:]; var placed: [(Double, Double)] = []
    // every bubble line sampled, so a pill can keep off the other lines too (not only off nodes and pills)
    var samples: [String: [(Double, Double)]] = [:]
    if !list {
      let pts = ports
      for e in graph.edges where !e.inside {
        guard let a = idx[e.a], let b = idx[e.b] else { continue }
        let (A, B) = ends(e, a, b, pts), (c, _) = control(A, B)
        samples[e.id] = (0...24).map { k in let t = Double(k) / 24, u = 1 - t; return (u * u * A.0 + 2 * u * t * c.0 + t * t * B.0, u * u * A.1 + 2 * u * t * c.1 + t * t * B.1) }
      }
    }
    for e in graph.edges {
      guard let pt = labelPoint(e, idx, placed: placed, others: samples.filter { $0.key != e.id }.map { $0.value }) else { continue }
      out[e.id] = pt; placed.append((pt.x / s, pt.y / s))
    }
    return out
  }

  func labelPoint(_ e: GraphEdge, _ idx: [String: GraphNode], placed: [(Double, Double)] = [], others: [[(Double, Double)]] = []) -> CGPoint? {
    guard let a = idx[e.a], let b = idx[e.b] else { return nil }
    if list {
      if e.inside { return nil }
      // along the arc, nearest its apex while clear of the pills placed before it
      let (y1, y2) = a.y < b.y ? (a.y, b.y) : (b.y, a.y)
      let k = bulge(y1, y2)
      var best = (a.x - k * 0.75, (y1 + y2) / 2, -Double.infinity)
      for i in 0...16 {
        let t = 0.2 + 0.6 * Double(i) / 16, u = 1 - t
        let w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
        let x = (w0 + w3) * a.x + (w1 + w2) * (a.x - k)
        let y = w0 * y1 + w1 * y1 + w2 * y2 + w3 * y2
        var clear = 40.0
        for q in placed { clear = min(clear, max(abs(q.0 - x) - 22, 0) + max(abs(q.1 - y) - 16, 0)) }
        let score = clear - abs(t - 0.5) * 10
        if score > best.2 { best = (x, y, score) }
      }
      return p(best.0, best.1)
    }
    if e.inside { return nil }   // the chip's second row says "↺ N internal convo"
    // the point on the curve farthest from every node (and the captions under agent dots), the other pills and the
    // other lines, so the pill never sits on one
    let (A, B) = ends(e, a, b, ports)
    let (c, _) = control(A, B)
    var best = (0.5, -Double.infinity)
    let hw = pillHalfWidth(e) / s, hh = 9 / s
    for k in 0...24 {
      let t = 0.12 + 0.76 * Double(k) / 24, u = 1 - t
      let x = u * u * A.0 + 2 * u * t * c.0 + t * t * B.0, y = u * u * A.1 + 2 * u * t * c.1 + t * t * B.1
      var clear = Double.infinity
      for n in graph.nodes { clear = min(clear, gap(x, y, n, halfW: hw, halfH: 9)) }
      for q in placed { clear = min(clear, max(abs(q.0 - x) - hw * 2 - 4, 0) + max(abs(q.1 - y) - 18, 0)) }
      var lineClear = Double.infinity
      for line in others { for q in line { lineClear = min(lineClear, max(abs(q.0 - x) - hw, 0) + max(abs(q.1 - y) - hh, 0)) } }
      // off every chip first (a pill on a chip is the worst), then off other lines, then near the middle
      let score = min(clear * s, 12) * 4 + min(clear * s, 40) + min(lineClear * s, 14) * 1.5 - abs(t - 0.5) * 4
      if score > best.1 { best = (t, score) }
    }
    let t = best.0, u = 1 - t
    return p(u * u * A.0 + 2 * u * t * c.0 + t * t * B.0, u * u * A.1 + 2 * u * t * c.1 + t * t * B.1)
  }

  /// Free space between a pill (centre x, y; half size halfW × halfH) and a node: its chip, or its dot plus the
  /// caption under it.
  func gap(_ x: Double, _ y: Double, _ n: GraphNode, halfW: Double, halfH: Double) -> Double {
    let (hw, top, bottom): (Double, Double, Double) = n.w > 0 ? (n.w / 2, n.h / 2, n.h / 2)
      : n.kind == "group" ? (n.r, n.r, n.r) : (max(n.r, 50), n.r, n.r + 30)
    let dx = max(abs(x - n.x) - hw - halfW, 0)
    let dy = max(y < n.y ? n.y - y - top - halfH : y - n.y - bottom - halfH, 0)
    return (dx * dx + dy * dy).squareRoot()
  }

  /// More conversations and more recent turns draw a thicker line; zoomed out, every line is thin.
  func width(_ e: GraphEdge) -> Double {
    if lvl == .dots { return 1.4 }
    return min(7, 2 + Double(min(max(e.live, 1) - 1, 4)) * 1.2 + Double(min(e.recent, 8)) * 0.35)
  }

  /// The pill's text: the count in the list, the richer detail ("11/20 turns · 2m") in the bubbles.
  func pillText(_ e: GraphEdge) -> String {
    let n = e.live + e.pending
    if e.inside { return "↺ \(n) internal convo\(n == 1 ? "" : "s")" }
    return list ? "\(n)" : (e.detail.isEmpty ? e.label : e.detail)
  }
  func pillHalfWidth(_ e: GraphEdge) -> Double { Double(pillText(e).count) * 3.1 + 8 }

  /// Where a line leaves an end node, and the direction it travels there: the arrowhead.
  func arrow(_ e: GraphEdge, _ idx: [String: GraphNode], atB: Bool) -> (CGPoint, CGVector)? {
    guard let na = idx[e.a], let nb = idx[e.b], !e.inside else { return nil }
    let (A, B) = ends(e, na, nb, ports)
    let (c, _) = control(A, B)
    let end = atB ? nb : na
    let a = (x: A.0, y: A.1), b = (x: B.0, y: B.1)
    func q(_ t: Double) -> (Double, Double) { let u = 1 - t; return (u * u * a.x + 2 * u * t * c.0 + t * t * b.x, u * u * a.y + 2 * u * t * c.1 + t * t * b.y) }
    func inside(_ pt: (Double, Double)) -> Bool {
      let dx = abs(pt.0 - end.x) * s, dy = abs(pt.1 - end.y) * s
      if end.w > 0 { return dx <= end.w / 2 + 3 && dy <= end.h / 2 + 3 }
      return (dx * dx + dy * dy).squareRoot() <= end.r * s + 3
    }
    var t = atB ? 1.0 : 0.0
    while (atB ? t > 0.5 : t < 0.5) && inside(q(t)) { t += atB ? -0.01 : 0.01 }
    let pt = q(t), u = 1 - t
    var dx = 2 * u * (c.0 - a.x) + 2 * t * (b.x - c.0), dy = 2 * u * (c.1 - a.y) + 2 * t * (b.y - c.1)
    if !atB { dx = -dx; dy = -dy }
    return (p(pt.0, pt.1), CGVector(dx: dx, dy: dy))
  }

  @ViewBuilder func edgeView(_ e: GraphEdge, _ idx: [String: GraphNode]) -> some View {
    let sel = selectedEdge(e)
    let waiting = e.waiting > 0
    let colour = waiting ? Color.abNeed : GraphPalette.line
    let hot = hoverLine == e.id && !list, faded = hoverLine != nil && !hot && !list
    if e.live > 0, let path = edgePath(e, idx, offset: e.pending > 0 ? -3 : 0) {
      if hot { path.stroke(colour.opacity(Hover.halo), style: StrokeStyle(lineWidth: width(e) + Hover.haloWidth, lineCap: .round)) }
      path.stroke(colour.opacity(faded ? Hover.fadedLine : sel || hot ? 1 : 0.85), style: StrokeStyle(lineWidth: width(e) + (sel ? 2.5 : 0) + (hot ? 0.8 : 0), lineCap: .round, dash: waiting ? [6, 4] : []))
        .contentShape(path.strokedPath(StrokeStyle(lineWidth: 14)))
        .onTapGesture { tapEdge(e) }
        .help(e.detail.isEmpty ? e.label : e.detail)
      if lvl == .chips && !list {
        ForEach(arrowEnds(e), id: \.self) { atB in
          if let (tip, dir) = arrow(e, idx, atB: atB) { ArrowHead(tip: tip, dir: dir, size: 6 + width(e) * 0.8).fill(colour.opacity(faded ? Hover.fadedLine : 1)) }
        }
      }
    }
    if e.pending > 0, let path = edgePath(e, idx, offset: e.live > 0 ? 3 : 0) {
      path.stroke(Color.abNeed.opacity(faded ? Hover.fadedLine : 1), style: StrokeStyle(lineWidth: sel ? 3 : 2, lineCap: .round, dash: [5, 4]))
        .contentShape(path.strokedPath(StrokeStyle(lineWidth: 14)))
        .onTapGesture { tapEdge(e) }
        .help(e.label)
    }
  }

  func arrowEnds(_ e: GraphEdge) -> [Bool] { e.direction == "both" ? [true, false] : [e.direction == "ab"] }

  @ViewBuilder func edgeLabel(_ e: GraphEdge, _ point: CGPoint?) -> some View {
    if let pt = point {
      let coral = e.live == 0 || e.waiting > 0
      let hot = hoverLine == e.id && !list, faded = hoverLine != nil && !hot && !list
      Text(hot ? "\(hoverNames(e)) · \(pillText(e))" : pillText(e)).font(.system(size: 10.5, weight: .medium))
        .foregroundColor(coral ? .abNeed : GraphPalette.line)
        .padding(.horizontal, 6).padding(.vertical, 1.5)
        .background(Capsule().fill(GraphPalette.chip))
        .overlay(Capsule().strokeBorder((coral ? Color.abNeed : GraphPalette.line).opacity(selectedEdge(e) || hot ? 1 : 0.6), lineWidth: selectedEdge(e) ? 1.6 : 1))
        .fixedSize()
        .opacity(faded ? Hover.fadedPill : 1)
        .position(pt)
        .onTapGesture { tapEdge(e) }
    }
  }

  /// "mobile → api" (whoever started it first), or "api ↔ mobile" when both sides started one: the hovered line's ends.
  func hoverNames(_ e: GraphEdge) -> String {
    let idx = nodeIndex
    let a = idx[e.a].map { $0.kind == "agent" ? bareName($0.id) : $0.label } ?? e.a
    let b = idx[e.b].map { $0.kind == "agent" ? bareName($0.id) : $0.label } ?? e.b
    switch e.direction { case "ab": return "\(a) → \(b)"; case "ba": return "\(b) → \(a)"; default: return "\(a) ↔ \(b)" }
  }

  // boxes: bubbles → dashed box with a header; list → header row

  @ViewBuilder func boxView(_ b: GraphBox) -> some View {
    if list {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary)
        Text(b.label.uppercased()).font(.system(size: 10.5, weight: .semibold)).foregroundColor(.secondary)
        Text("\(b.count)").font(.system(size: 10.5)).foregroundColor(.secondary)
        Spacer()
      }
      .padding(.leading, 12)
      .frame(width: b.w * s, height: b.h * s).contentShape(Rectangle())
      .position(x: (b.x + b.w / 2) * s, y: b.y * s)
      .onTapGesture { tapGroup(b.id) }
      .help("Close \(b.label)")
    } else {
      ZStack(alignment: .topLeading) {
        RoundedRectangle(cornerRadius: 12).strokeBorder(GraphPalette.border, style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
        HStack(spacing: 5) {
          Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary)
          Text(b.label).fontWeight(.semibold).lineLimit(1).truncationMode(.tail)
          Text("\(b.count)").foregroundColor(.secondary)
        }
        .font(.system(size: 11.5)).padding(.leading, 10).padding(.top, 7)
        .contentShape(Rectangle())
        .onTapGesture { tapGroup(b.id) }
        .help("Close \(b.label)")
      }
      .frame(width: b.w * s, height: b.h * s)
      .position(x: (b.x + b.w / 2) * s, y: (b.y + b.h / 2) * s)
    }
  }

  // nodes

  func isSelected(_ n: GraphNode) -> Bool { if case .node(let id) = selection { return id == n.id }; return false }

  func ring(_ n: GraphNode) -> Color {
    if let st = n.state { return st == .idle ? .abWork : st == .closed ? Color.secondary : stateColor(st) }
    if let b = n.bar { return b.needs_you > 0 ? .abNeed : b.talking > 0 ? GraphPalette.line : b.working > 0 ? .abWork : Color.secondary }
    return Color.secondary
  }

  @ViewBuilder func nodeView(_ n: GraphNode) -> some View {
    if list { listRowView(n) } else { bubbleView(n) }
  }

  @ViewBuilder func bubbleView(_ n: GraphNode) -> some View {
    if lvl == .dots { dotView(n) } else { chipView(n) }
  }

  /// Zoomed out: every node is a small dot; groups keep their state ring and count, names only on groups of 3 or more.
  @ViewBuilder func dotView(_ n: GraphNode) -> some View {
    switch n.kind {
    case "group":
      let bar = n.bar ?? StateBar()
      StateDonut(bar: bar, size: 26)
        .background(Circle().fill(GraphPalette.chip))
        .overlay(Circle().strokeBorder(Color.abNeed, lineWidth: bar.needs_you > 0 ? 1.6 : 0).padding(-3))
        .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: isSelected(n) ? 2 : 0).padding(-6))
        .overlay(alignment: .top) {
          if bar.total >= 3 {
            Text(n.label).font(.system(size: 10)).foregroundColor(.secondary).lineLimit(1).fixedSize().offset(y: 30)
          }
        }
        .position(x: n.x * s, y: n.y * s)
        .gesture(chipDrag(n))
        .onTapGesture { selection = .node(n.id) }
        .help("\(n.label): \(n.sub)\(graph.movable ? ". Drag to move." : "")")
    default:
      let r = max(4.5, min(n.r * s, 8))
      Circle().fill(n.kind == "more" ? Color.clear : GraphPalette.chip)
        .overlay(Circle().strokeBorder(n.kind == "more" ? Color.secondary.opacity(0.7) : ring(n), style: StrokeStyle(lineWidth: 1.6, dash: n.kind == "more" ? [2, 2] : [])))
        .frame(width: r * 2, height: r * 2)
        .position(x: n.x * s, y: n.y * s)
        .onTapGesture { if n.kind == "more" { tapMore(n.group) } else { selection = .node(n.id) } }
        .help(n.kind == "more" ? "\(n.label) · \(n.sub)" : n.id)
    }
  }

  @ViewBuilder func chipView(_ n: GraphNode) -> some View {
    let r = n.r * s
    switch n.kind {
    case "group":
      DonutChip(node: n, selected: isSelected(n), urgent: ring(n), inside: graph.edges.first { $0.inside && $0.a == n.id }, tapInside: tapEdge)
        .frame(width: n.w, height: n.h)
        .overlay(RoundedRectangle(cornerRadius: 11).fill(GraphPalette.line.opacity(lit(n) ? Hover.tint : 0)).allowsHitTesting(false))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(GraphPalette.line.opacity(0.8), lineWidth: lit(n) ? Hover.ring : 0))
        .opacity(faded(n) ? Hover.fadedNode : 1)
        .position(x: n.x * s, y: n.y * s)
        .gesture(chipDrag(n))
        .onTapGesture { tapGroup(n.id); selection = .node(n.id) }
        .help("\(n.label): \(n.sub) (\(n.mix ?? "")). \(graph.movable ? "Drag to move, click to open the group." : "Click to open the group.")")
        .accessibilityLabel("\(n.label), \(n.sub)")
    case "more":
      VStack(spacing: 3) {
        Text(n.label).font(.system(size: 10.5, weight: .medium)).foregroundColor(.secondary)
          .frame(width: r * 2, height: r * 2)
          .overlay(Circle().strokeBorder(Color.secondary.opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [2, 2])))
        Text(n.sub).font(.system(size: 9.5)).foregroundColor(.secondary).lineLimit(1).fixedSize()
          .padding(.horizontal, 3).background(RoundedRectangle(cornerRadius: 3).fill(GraphPalette.canvas.opacity(0.9)))
      }
      .contentShape(Rectangle())
      .position(x: n.x * s, y: n.y * s + 7)
      .onTapGesture { tapMore(n.group) }
      .help("Show them")
    default:
      VStack(spacing: 2) {
        ZStack {
          Circle().fill(GraphPalette.chip)
          if n.state == .talking || n.state == .working || n.state == .needsYou { Circle().fill(ring(n).opacity(0.18)) }
          Circle().strokeBorder(ring(n), lineWidth: 2.5)
          if let app = n.app, AppIcons.icon(app) != nil { AppIconView(app: app, size: r * 1.25) }
          else { Text(n.badge ?? "").font(.system(size: 8.5, weight: .semibold, design: .monospaced)).foregroundColor(.secondary) }
        }
        .frame(width: r * 2, height: r * 2)
        .overlay(Circle().strokeBorder(Color.accentColor, lineWidth: isSelected(n) ? 2 : 0).padding(-4))
        .overlay(Circle().strokeBorder(GraphPalette.line.opacity(0.8), lineWidth: lit(n) ? Hover.ring : 0).padding(-3))
        VStack(spacing: 0) {
          Text(n.label).font(.system(size: 10.5)).lineLimit(1).truncationMode(.middle)
          Text(n.sub).font(.system(size: 9.5)).foregroundColor(.secondary).lineLimit(1)
        }
        .frame(maxWidth: 118).padding(.horizontal, 3)
        .background(RoundedRectangle(cornerRadius: 3).fill(GraphPalette.canvas.opacity(0.9)))
      }
      .fixedSize()
      .contentShape(Rectangle())
      .opacity(faded(n) ? Hover.fadedNode : 1)
      .position(x: n.x * s, y: n.y * s + 14)
      .onTapGesture { selection = .node(n.id) }
      .help([n.id, n.tag].compactMap { $0 }.joined(separator: " · "))
      .accessibilityLabel("\(n.id), \(n.tag ?? "idle")")
    }
  }

  // MARK: zoomed in (cards)

  static let cardW = 222.0, cardH = 36.0, cardGap = 4.0, headH = 28.0, moreH = 16.0

  /// A closed group opened into agent cards, centred where its chip was. Sizes in points (they don't scale).
  /// `c`: the stack's centre in points, which starts where the chip was and moves only if stacks would overlap.
  struct CardStack { let node: GraphNode; let shown: [AgentRow]; let folded: [AgentRow]; let h: Double; var c: CGPoint }

  func cardStacks() -> [String: CardStack] {
    var out: [String: CardStack] = [:]
    var order: [String] = []
    for n in graph.nodes where n.kind == "group" {
      guard let g = groups.first(where: { $0.id == n.id }) else { continue }
      let k = cardsShown(g.agents.count, zoom: zoom)
      let shown = Array(g.agents.prefix(k)), folded = Array(g.agents.dropFirst(k))
      let h = Self.headH + Self.cardGap + Double(k) * (Self.cardH + Self.cardGap) + (folded.isEmpty ? 0 : Self.moreH) + 4
      out[n.id] = CardStack(node: n, shown: shown, folded: folded, h: h, c: p(n.x, n.y))
      order.append(n.id)
    }
    // opened stacks are taller than chips: push overlapping ones apart (each by half, along the shorter overlap) so
    // cards never sit on cards; the layout around them is otherwise kept
    let gapX = 28.0, gapY = 22.0
    for _ in 0..<40 {
      var moved = false
      for i in order.indices {
        for j in order.indices where j > i {
          guard let A = out[order[i]], let B = out[order[j]] else { continue }
          let ox = (Self.cardW + gapX) - abs(A.c.x - B.c.x), oy = (A.h + B.h) / 2 + gapY - abs(A.c.y - B.c.y)
          guard ox > 0, oy > 0 else { continue }
          moved = true
          if ox < oy {
            let d = (A.c.x <= B.c.x ? -1.0 : 1.0) * ox / 2
            out[order[i]]!.c.x += d; out[order[j]]!.c.x -= d
          } else {
            let d = (A.c.y <= B.c.y ? -1.0 : 1.0) * oy / 2
            out[order[i]]!.c.y += d; out[order[j]]!.c.y -= d
          }
        }
      }
      if !moved { break }
    }
    return out
  }

  /// Where an agent's lines attach: its card's centre and half width; `stack` when it sits in a zoomed-in group.
  struct CardAnchor { let p: CGPoint; let hw: Double; let stack: String? }

  func cardAnchors(_ stacks: [String: CardStack]) -> [String: CardAnchor] {
    var out: [String: CardAnchor] = [:]
    for (id, st) in stacks {
      let top = st.c.y - st.h / 2, c = st.c
      for (i, a) in st.shown.enumerated() {
        let y = top + Self.headH + Self.cardGap + Double(i) * (Self.cardH + Self.cardGap) + Self.cardH / 2
        // the card is cardW - 10 wide (5 pt inset in its stack); lines end 3 pt outside it so the arrowhead shows
        out[a.address] = CardAnchor(p: CGPoint(x: c.x, y: y), hw: Self.cardW / 2 - 2, stack: id)
      }
      for a in st.folded { out[a.address] = CardAnchor(p: CGPoint(x: c.x, y: top + Self.headH / 2), hw: Self.cardW / 2 + 2, stack: nil) }
    }
    for n in graph.nodes where n.kind == "agent" {
      out[n.id] = CardAnchor(p: p(n.x, n.y), hw: agentCardWidth / 2 + 3, stack: nil)
    }
    // an opened group's folded agents attach to its "+N" node
    for n in graph.nodes where n.kind == "more" {
      for a in groups.first(where: { $0.id == n.group })?.agents ?? [] where out[a.address] == nil {
        out[a.address] = CardAnchor(p: p(n.x, n.y), hw: n.r * s, stack: nil)
      }
    }
    return out
  }

  /// An opened group's agents become cards in their grid cells; never wider than the cell.
  var agentCardWidth: Double { min(Self.cardW - 20, max(110, 128 * s - 12)) }

  func agentRow(_ address: String) -> AgentRow? {
    for g in groups { if let a = g.agents.first(where: { $0.address == address }) { return a } }
    return nil
  }

  /// A card-to-card line: out of the side facing the other card, into the other's facing side. Two cards in one
  /// stack: a loop on the stack's right.
  /// Start, two control points, end: a cubic.
  struct CardCurve {
    let p0: CGPoint, c1: CGPoint, c2: CGPoint, p1: CGPoint
    let dir: CGVector
    func at(_ t: Double) -> CGPoint {
      let u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
      return CGPoint(x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p1.x, y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p1.y)
    }
    var path: Path { var p = Path(); p.move(to: p0); p.addCurve(to: p1, control1: c1, control2: c2); return p }
  }

  func cardGeometry(_ a: CardAnchor, _ b: CardAnchor) -> CardCurve {
    let sameColumn = (a.stack != nil && a.stack == b.stack) || abs(b.p.x - a.p.x) < a.hw + b.hw
    if sameColumn {
      let x = max(a.p.x + a.hw, b.p.x + b.hw)
      let k = 28 + min(60, abs(b.p.y - a.p.y) * 0.25)
      return CardCurve(p0: CGPoint(x: a.p.x + a.hw, y: a.p.y), c1: CGPoint(x: x + k, y: a.p.y), c2: CGPoint(x: x + k, y: b.p.y),
                       p1: CGPoint(x: b.p.x + b.hw, y: b.p.y), dir: CGVector(dx: -1, dy: 0))
    }
    let dir: CGFloat = b.p.x >= a.p.x ? 1 : -1
    let s0 = CGPoint(x: a.p.x + dir * a.hw, y: a.p.y), e0 = CGPoint(x: b.p.x - dir * b.hw, y: b.p.y)
    let k = max(40, abs(e0.x - s0.x) * 0.4)
    return CardCurve(p0: s0, c1: CGPoint(x: s0.x + dir * k, y: s0.y), c2: CGPoint(x: e0.x - dir * k, y: e0.y), p1: e0, dir: CGVector(dx: dir, dy: 0))
  }

  /// Every card line's pill, placed one after another along its own curve so pills never sit on each other.
  func placeCardLabels(_ lines: [CardLine], _ anchors: [String: CardAnchor]) -> [String: CGPoint] {
    var out: [String: CGPoint] = [:]; var placed: [(CGPoint, Double)] = []
    for l in lines {
      guard let a = anchors[l.from], let b = anchors[l.to] else { continue }
      let curve = cardGeometry(a, b), hw = Double(l.detail.count) * 3 + 8
      var best = curve.at(0.5), bestScore = -Double.infinity
      for t in [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78] {
        let q = curve.at(t)
        var clear = 30.0
        for (o, ohw) in placed { clear = min(clear, max(abs(o.x - q.x) - hw - ohw - 4, 0) + max(abs(o.y - q.y) - 18, 0)) }
        let score = clear - abs(t - 0.5) * 8
        if score > bestScore { best = q; bestScore = score }
      }
      out[l.id] = best; placed.append((best, hw))
    }
    return out
  }

  func selectedLine(_ l: CardLine) -> Bool { if case .conversation(let id, _) = selection { return id == l.id }; return false }

  func lineColour(_ l: CardLine) -> Color { l.pending || l.waiting ? .abNeed : GraphPalette.line }

  /// 100%: the merged line (or its pill) within reach of the pointer.
  func hitEdge(_ pt: CGPoint, _ idx: [String: GraphNode]) -> String? {
    let labels = placeLabels(idx), pts = ports
    var best: (String, Double)? = nil
    for e in graph.edges where !e.inside {
      if let c = labels[e.id], abs(pt.x - c.x) <= pillHalfWidth(e) + 2, abs(pt.y - c.y) <= 10 { return e.id }
      guard let na = idx[e.a], let nb = idx[e.b] else { continue }
      let (A, B) = ends(e, na, nb, pts), (c, _) = control(A, B)
      func q(_ t: Double) -> CGPoint { let u = 1 - t; return p(u * u * A.0 + 2 * u * t * c.0 + t * t * B.0, u * u * A.1 + 2 * u * t * c.1 + t * t * B.1) }
      var prev = q(0)
      for k in 1...30 {
        let cur = q(Double(k) / 30), d = distance(pt, prev, cur)
        if d <= 7, d < (best?.1 ?? .infinity) { best = (e.id, d) }
        prev = cur
      }
    }
    return best?.0
  }

  /// The hovered 100% line's two ends (node ids), for lighting them.
  var hoverEnds: Set<String> {
    guard lvl == .chips, !list, let e = graph.edges.first(where: { $0.id == hoverLine }) else { return [] }
    return [e.a, e.b]
  }
  func lit(_ n: GraphNode) -> Bool { hoverEnds.contains(n.id) }
  func faded(_ n: GraphNode) -> Bool { let ends = hoverEnds; return !ends.isEmpty && !ends.contains(n.id) }

  /// The line or its pill within reach of the pointer, if any.
  func hitCardLine(_ pt: CGPoint, _ lines: [CardLine], _ anchors: [String: CardAnchor], _ pills: [String: CGPoint]) -> String? {
    var best: (String, Double)? = nil
    for l in lines {
      if let c = pills[l.id], abs(pt.x - c.x) <= Double(l.detail.count) * 3 + 10, abs(pt.y - c.y) <= 10 { return l.id }
      guard let a = anchors[l.from], let b = anchors[l.to] else { continue }
      let curve = cardGeometry(a, b)
      var prev = curve.at(0)
      for k in 1...30 {
        let q = curve.at(Double(k) / 30)
        let d = distance(pt, prev, q)
        if d <= 7, d < (best?.1 ?? .infinity) { best = (l.id, d) }
        prev = q
      }
    }
    return best?.0
  }

  func distance(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> Double {
    let dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy
    let t = len2 == 0 ? 0 : max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    let x = a.x + t * dx - p.x, y = a.y + t * dy - p.y
    return (x * x + y * y).squareRoot()
  }

  @ViewBuilder func cardLineView(_ l: CardLine, _ anchors: [String: CardAnchor]) -> some View {
    if let a = anchors[l.from], let b = anchors[l.to] {
      let curve = cardGeometry(a, b)
      let path = curve.path, tip = curve.p1, dir = curve.dir
      let hot = hoverLine == l.id, faded = hoverLine != nil && !hot
      let w = min(5, 1.8 + Double(min(l.recent, 8)) * 0.35) + (selectedLine(l) ? 2 : 0) + (hot ? 0.8 : 0)
      let colour = lineColour(l)
      if hot { path.stroke(colour.opacity(Hover.halo), style: StrokeStyle(lineWidth: w + Hover.haloWidth, lineCap: .round)) }
      path.stroke(colour.opacity(faded ? Hover.fadedLine : hot ? 1 : 0.9), style: StrokeStyle(lineWidth: w, lineCap: .round, dash: l.pending || l.waiting ? [6, 4] : []))
        .contentShape(path.strokedPath(StrokeStyle(lineWidth: 12)))
        .onTapGesture { selection = .conversation(l.id, from: nil) }
      ArrowHead(tip: tip, dir: dir, size: 7 + w * 0.6).fill(colour.opacity(faded ? Hover.fadedLine : 1))
    }
  }

  @ViewBuilder func cardLineLabel(_ l: CardLine, _ at: CGPoint?) -> some View {
    if let mid = at {
      let hot = hoverLine == l.id, faded = hoverLine != nil && !hot
      // hovered: who talks to whom, so the two agents are named even when one is folded into "+N more"
      Text(hot ? "\(bareName(l.from)) → \(bareName(l.to)) · \(l.detail)" : l.detail)
        .font(.system(size: 10, weight: .medium))
        .foregroundColor(lineColour(l))
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(Capsule().fill(GraphPalette.chip))
        .overlay(Capsule().strokeBorder(lineColour(l).opacity(selectedLine(l) || hot ? 1 : 0.55)))
        .opacity(faded ? Hover.fadedPill : 1)
        .fixedSize()
        .position(mid)
        .onTapGesture { selection = .conversation(l.id, from: nil) }
    }
  }

  @ViewBuilder func cardNodeView(_ n: GraphNode, _ stacks: [String: CardStack], ends: Set<String> = []) -> some View {
    switch n.kind {
    case "group":
      if let st = stacks[n.id] { groupStack(st, ends: ends) } else { chipView(n) }
    case "agent":
      if let a = agentRow(n.id) {
        AgentCard(agent: a, line: agentCardLine(a, model.live), selected: isSelected(n),
                  lit: ends.contains(a.address), faded: !ends.isEmpty && !ends.contains(a.address))
          .frame(width: agentCardWidth, height: Self.cardH)
          .position(p(n.x, n.y))
          .onTapGesture { selection = .node(n.id) }
          .help(n.id)
      } else { chipView(n) }
    default:
      chipView(n)
    }
  }

  func groupStack(_ st: CardStack, ends: Set<String> = []) -> some View {
    let n = st.node
    let needs = (n.bar?.needs_you ?? 0) > 0
    return VStack(alignment: .leading, spacing: Self.cardGap) {
      HStack(spacing: 6) {
        if let bar = n.bar { StateDonut(bar: bar, size: 18) }
        Text(n.label).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
        Spacer(minLength: 4)
        ForEach(n.apps ?? [], id: \.app) { a in
          HStack(spacing: 2) { AppIconView(app: a.app, size: 13); Text("\(a.count)").font(.system(size: 10)).foregroundColor(.secondary) }
        }
      }
      .padding(.horizontal, 8)
      .frame(height: Self.headH)
      .contentShape(Rectangle())
      .onTapGesture { selection = .node(n.id) }
      .help("\(n.label): \(n.sub)\(graph.movable ? ". Drag to move." : "")")
      ForEach(st.shown) { a in
        AgentCard(agent: a, line: agentCardLine(a, model.live), selected: selection == .node(a.address),
                  lit: ends.contains(a.address), faded: !ends.isEmpty && !ends.contains(a.address))
          .frame(height: Self.cardH)
          .padding(.horizontal, 5)
          .onTapGesture { selection = .node(a.address) }
          .help(a.address)
      }
      if !st.folded.isEmpty {
        let litFolded = st.folded.contains { ends.contains($0.address) }
        Text("+\(st.folded.count) more · zoom in or click to open").font(.system(size: 10, weight: litFolded ? .semibold : .regular))
          .foregroundColor(litFolded ? GraphPalette.line : .secondary).lineLimit(1)
          .padding(.leading, 10).frame(height: Self.moreH)
          .contentShape(Rectangle())
          .onTapGesture { tapGroup(n.id) }
      }
    }
    .frame(width: Self.cardW, height: st.h, alignment: .top)
    .background(RoundedRectangle(cornerRadius: 12).fill(GraphPalette.canvas.opacity(0.75)))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(needs ? Color.abNeed.opacity(0.8) : GraphPalette.border, style: StrokeStyle(lineWidth: 1.2, dash: [4, 3])))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.accentColor, lineWidth: isSelected(n) ? 2 : 0).padding(-4))
    .position(st.c)
    .gesture(chipDrag(n))
  }

  @ViewBuilder func listRowView(_ n: GraphNode) -> some View {
    let rowW = (graph.width - n.x - 8) * s
    let h = n.r * 2 * s
    let row = HStack(spacing: 6) {
      switch n.kind {
      case "group":
        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary)
        Text(n.label).fontWeight(.semibold).lineLimit(1)
        if let e = graph.edges.first(where: { $0.inside && $0.a == n.id }) {
          let k = e.live + e.pending
          Text("↺ \(k) internal convo\(k == 1 ? "" : "s")").font(.system(size: 11)).foregroundColor(GraphPalette.line).lineLimit(1)
            .onTapGesture { tapEdge(e) }
        }
        Spacer(minLength: 6)
        Text(n.sub).font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(1)
        ForEach(n.apps ?? [], id: \.app) { a in
          HStack(spacing: 3) { AppIconView(app: a.app, size: 14); Text("\(a.count)").font(.system(size: 10.5)).foregroundColor(.secondary) }
        }
        if let b = n.bar { StateBarView(bar: b) }
      case "more":
        Text("\(n.label) · \(n.sub)").font(.system(size: 11)).foregroundColor(.secondary)
        Spacer()
      default:
        AppIconView(app: n.app ?? "", size: 14)
        Text(n.label).lineLimit(1).truncationMode(.middle)
        Spacer(minLength: 6)
        Text(n.sub).font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(1)
        if let tag = n.tag, let st = n.state { TagView(text: tag, state: st) }
      }
    }
    .font(.system(size: 12))
    .padding(.horizontal, 10)
    .frame(width: rowW, height: h)
    .background(RoundedRectangle(cornerRadius: 5).fill(n.kind == "more" ? Color.clear : GraphPalette.chip))
    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(n.kind == "more" ? Color.clear : GraphPalette.border))
    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.accentColor, lineWidth: isSelected(n) ? 1.5 : 0))
    .contentShape(Rectangle())
    ZStack(alignment: .topLeading) {
      row.position(x: n.x * s + 8 + rowW / 2, y: n.y * s)
      if n.kind != "more" {
        Circle().fill(ring(n)).frame(width: 7, height: 7).position(p(n.x, n.y))
      }
    }
    .onTapGesture {
      switch n.kind { case "group": tapGroup(n.id); selection = .node(n.id); case "more": tapMore(n.group); default: selection = .node(n.id) }
    }
  }
}

/// How strongly hovering a line marks it and its two ends: a light touch, the rest of the graph stays readable.
enum Hover {
  static let halo = 0.14, haloWidth = 5.0
  static let fadedLine = 0.5, fadedPill = 0.6, fadedNode = 0.7
  static let tint = 0.07, ring = 1.5
}

/// A filled arrowhead with its tip at `tip`, pointing along `dir`.
struct ArrowHead: Shape {
  let tip: CGPoint; let dir: CGVector; var size: Double = 7
  func path(in rect: CGRect) -> Path {
    let len = max(0.001, (dir.dx * dir.dx + dir.dy * dir.dy).squareRoot())
    let ux = dir.dx / len, uy = dir.dy / len
    let back = CGPoint(x: tip.x - ux * size, y: tip.y - uy * size)
    var p = Path()
    p.move(to: tip)
    p.addLine(to: CGPoint(x: back.x - uy * size * 0.55, y: back.y + ux * size * 0.55))
    p.addLine(to: CGPoint(x: back.x + uy * size * 0.55, y: back.y - ux * size * 0.55))
    p.closeSubpath()
    return p
  }
}

/// Zoomed in: one agent. App icon, name, then its live conversation's turns and age (or its state); a state dot.
struct AgentCard: View {
  let agent: AgentRow; let line: String; let selected: Bool
  /// Hovering a line: its two agents light up, every other card fades.
  var lit = false; var faded = false
  var body: some View {
    let needs = agent.state == .needsYou
    let dot: Color = agent.state == .talking ? GraphPalette.line : needs ? .abNeed : agent.state == .working ? .abWork : GraphPalette.idle
    HStack(spacing: 7) {
      AppIconView(app: agent.app, size: 16)
      VStack(alignment: .leading, spacing: 0) {
        Text(agent.name).font(.system(size: 11.5, weight: .medium)).lineLimit(1).truncationMode(.middle)
        Text(line).font(.system(size: 10)).foregroundColor(needs ? .abNeed : .secondary).lineLimit(1)
      }
      Spacer(minLength: 0)
      Circle().fill(dot).frame(width: 6, height: 6)
    }
    .padding(.horizontal, 8)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(RoundedRectangle(cornerRadius: 7).fill(needs ? GraphPalette.needChip : GraphPalette.chip))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(needs ? Color.abNeed : GraphPalette.border, lineWidth: needs ? 1.3 : 1))
    .overlay(RoundedRectangle(cornerRadius: 7).fill(GraphPalette.line.opacity(lit ? Hover.tint : 0)).allowsHitTesting(false))
    .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(GraphPalette.line.opacity(0.8), lineWidth: lit ? Hover.ring : 0))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.accentColor, lineWidth: selected ? 2 : 0).padding(-3))
    .opacity(faded ? Hover.fadedNode : 1)
    .contentShape(RoundedRectangle(cornerRadius: 7))
  }
}

struct GraphLegend: View {
  var body: some View {
    HStack(spacing: 12) {
      item { Capsule().fill(GraphPalette.line).frame(width: 16, height: 3) } label: { "live conversation" }
      item { Capsule().stroke(Color.abNeed, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2])).frame(width: 16, height: 2) } label: { "invite or waiting on you" }
      item { Circle().strokeBorder(Color.abNeed, lineWidth: 2).frame(width: 9, height: 9) } label: { "needs you" }
      item { Circle().strokeBorder(Color.abWork, lineWidth: 2).frame(width: 9, height: 9) } label: { "working / idle" }
    }
    .font(.system(size: 10.5)).foregroundColor(.secondary)
    .padding(.horizontal, 8).padding(.vertical, 4)
    .background(RoundedRectangle(cornerRadius: 6).fill(GraphPalette.chip.opacity(0.92)))
  }
  func item<V: View>(@ViewBuilder _ mark: () -> V, label: () -> String) -> some View { HStack(spacing: 4) { mark(); Text(label()) } }
}

// MARK: donut chip (a closed group)

/// The installed app's own icon for an agent app (Claude Code → the Claude app, Codex → OpenAI's Codex app, …),
/// read from macOS at run time; nothing is bundled. nil when that app isn't installed: the letter badge stands in.
enum AppIcons {
  static let bundleIds: [String: [String]] = [
    "claude": ["com.anthropic.claudefordesktop"],
    "codex": ["com.openai.codex"],
    "cursor": ["com.todesktop.230313mzl4w4u92"],
  ]
  /// Apps whose bundle id we don't know: looked up by name in the Applications folders.
  static let appNames: [String: [String]] = ["grok": ["Grok Bot.app", "Grok.app"]]
  private static var cache: [String: NSImage?] = [:]
  static func icon(_ app: String) -> NSImage? {
    if let hit = cache[app] { return hit }
    let byId = (bundleIds[app] ?? []).lazy.compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
    let byName = (appNames[app] ?? []).lazy.flatMap { name in
      ["/Applications", NSHomeDirectory() + "/Applications"].map { URL(fileURLWithPath: $0).appendingPathComponent(name) }
    }.first { FileManager.default.fileExists(atPath: $0.path) }
    let found = (byId ?? byName).map { NSWorkspace.shared.icon(forFile: $0.path) }
    cache[app] = found
    return found
  }
}

struct AppIconView: View {
  let app: String; var size: CGFloat = 16
  var body: some View {
    if let img = AppIcons.icon(app) {
      Image(nsImage: img).resizable().interpolation(.high).frame(width: size, height: size)
    } else {
      Text(appBadge(app)).font(.system(size: size * 0.55, weight: .semibold, design: .monospaced)).foregroundColor(.secondary)
        .frame(width: size, height: size)
        .background(RoundedRectangle(cornerRadius: size * 0.25).fill(Color(nsColor: .quaternaryLabelColor)))
    }
  }
}

/// The group's agents as a ring: talking, needs you, working, idle, closed, with the count in the middle.
struct StateDonut: View {
  let bar: StateBar; var size: CGFloat = 22
  var body: some View {
    let parts: [(Int, Color)] = [(bar.talking, GraphPalette.line), (bar.needs_you, .abNeed), (bar.working, .abWork),
                                 (bar.idle, GraphPalette.idle), (bar.closed, Color(nsColor: .quaternaryLabelColor))]
    let total = Double(max(bar.total, 1))
    let gapFrac = bar.total > 1 ? 0.02 : 0
    ZStack {
      ForEach(Array(parts.enumerated()), id: \.offset) { k, part in
        if part.0 > 0 {
          let start = parts[..<k].reduce(0.0) { $0 + Double($1.0) } / total
          let end = start + Double(part.0) / total
          Circle().trim(from: start + gapFrac / 2, to: max(start + gapFrac / 2, end - gapFrac / 2))
            .stroke(part.1, style: StrokeStyle(lineWidth: 3.5, lineCap: .butt))
            .rotationEffect(.degrees(-90))
            .padding(2)   // the stroke stays inside the frame
        }
      }
      Text("\(bar.total)").font(.system(size: 9.5, weight: .semibold)).foregroundColor(.secondary)
    }
    .frame(width: size, height: size)
    .accessibilityLabel("\(bar.talking) talking, \(bar.needs_you) need you, \(bar.working) working, \(bar.idle) idle, \(bar.closed) closed")
  }
}

struct DonutChip: View {
  let node: GraphNode; let selected: Bool; let urgent: Color
  /// Conversations between agents of this group: a second row, "↺ N internal convo(s)", that opens them.
  var inside: GraphEdge? = nil
  var tapInside: (GraphEdge) -> Void = { _ in }

  var body: some View {
    let needs = (node.bar?.needs_you ?? 0) > 0
    VStack(alignment: .leading, spacing: 1) {
      HStack(spacing: 8) {
        if let bar = node.bar { StateDonut(bar: bar) }
        Text(node.label).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
          .layoutPriority(1)
        Spacer(minLength: 4)
        HStack(spacing: 8) {
          ForEach(node.apps ?? [], id: \.app) { a in
            HStack(spacing: 3) {
              AppIconView(app: a.app)
              Text("\(a.count)").font(.system(size: 10.5)).foregroundColor(.secondary)
            }
            .help("\(appNames[a.app] ?? a.app): \(a.count)")
          }
        }
        .fixedSize()
      }
      if let e = inside {
        let k = e.live + e.pending
        Text("↺ \(k) internal convo\(k == 1 ? "" : "s")").font(.system(size: 11)).foregroundColor(GraphPalette.line).lineLimit(1)
          .padding(.leading, 30)   // under the name, past the donut
          .contentShape(Rectangle())
          .onTapGesture { tapInside(e) }
          .help("Conversations between agents in \(node.label)")
      }
    }
    .padding(.leading, 9).padding(.trailing, 13)
    .frame(maxWidth: .infinity, maxHeight: .infinity)   // the chip fills its frame, so the border clears the content
    .background(RoundedRectangle(cornerRadius: 11).fill(needs ? GraphPalette.needChip : GraphPalette.chip))
    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(needs ? Color.abNeed : GraphPalette.border, lineWidth: needs ? 1.6 : 1))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.accentColor, lineWidth: selected ? 2 : 0).padding(-4))
    .contentShape(RoundedRectangle(cornerRadius: 11))
  }
}

// MARK: side pane

struct SidePane: View {
  let model: PanelModel
  let graph: GraphModel
  let groups: [AgentGroup]
  @Binding var selection: GraphSelection
  let toggleGroup: (String) -> Void

  var all: [ConversationRow] { model.live + model.ended }
  func conv(_ id: String) -> ConversationRow? { all.first { $0.id == id } }
  func nodeLabel(_ id: String) -> String {
    if let n = graph.nodes.first(where: { $0.id == id }) { return n.kind == "more" ? "\(n.label) in \(groups.first { $0.id == n.group }?.label ?? "")" : n.label }
    return displayName(id)
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        switch selection {
        case .none: overview
        case .edge(let id): edgePane(id)
        case .conversation(let id, let from): conversationPane(id, from: from)
        case .node(let id): nodePane(id)
        }
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  func title(_ t: String) -> some View { Text(t).font(.system(size: 13.5, weight: .semibold)).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
  func meta(_ t: String) -> some View { Text(t).font(.system(size: 11.5)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true) }
  func back(_ label: String, to: GraphSelection) -> some View {
    Button { selection = to } label: { Label(label, systemImage: "chevron.left").font(.system(size: 11.5)) }
      .buttonStyle(.plain).foregroundColor(.secondary)
  }

  func pick(_ c: ConversationRow, from: String?) -> some View {
    Button { selection = .conversation(c.id, from: from) } label: {
      Group { if c.live { ConversationRowView(row: c) } else { EndedRowView(row: c) } }
        .padding(6).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.5)))
        .contentShape(Rectangle())
    }.buttonStyle(.plain)
  }

  @ViewBuilder var overview: some View {
    title("Overview")
    meta("\(model.live.count) live conversation\(model.live.count == 1 ? "" : "s") · \(model.agentCount) agents" + (model.ended.isEmpty ? "" : " · \(model.ended.count) ended today"))
    if !model.needsYou.isEmpty { NeedsYouSection(rows: model.needsYou) }
    if !model.live.isEmpty {
      Text("LIVE").font(.system(size: 10.5, weight: .semibold)).foregroundColor(.secondary).padding(.top, 4)
      ForEach(model.live) { c in pick(c, from: nil) }
    }
    if !model.ended.isEmpty {
      Text("ENDED TODAY").font(.system(size: 10.5, weight: .semibold)).foregroundColor(.secondary).padding(.top, 4)
      ForEach(model.ended) { c in pick(c, from: nil) }
    }
    meta("Click a line to see its conversation, a group to open it. Approve or decline in each agent's own prompt.").padding(.top, 6)
  }

  @ViewBuilder func edgePane(_ id: String) -> some View {
    if let e = graph.edges.first(where: { $0.id == id }) {
      back("Overview", to: .none)
      title(e.inside ? "Internal convos in \(nodeLabel(e.a))" : "\(nodeLabel(e.a)) ↔ \(nodeLabel(e.b))")
      meta("\(e.conversations.count) conversation\(e.conversations.count == 1 ? "" : "s") · pick one")
      ForEach(e.conversations, id: \.self) { cid in if let c = conv(cid) { pick(c, from: id) } }
    } else { overview }
  }

  @ViewBuilder func conversationPane(_ id: String, from: String?) -> some View {
    if let c = conv(id) {
      if let from, graph.edges.contains(where: { $0.id == from }) { back("All on this line", to: .edge(from)) } else { back("Overview", to: .none) }
      HStack(spacing: 5) {
        AppIconView(app: appOf(c.from), size: 16); title(bareName(c.from))
        Text("↔").font(.system(size: 13.5, weight: .semibold))
        AppIconView(app: appOf(c.to), size: 16); title(bareName(c.to))
      }
      meta([c.topic.isEmpty ? "(no topic)" : c.topic, c.turns + " turns", c.live ? (c.pending ? "pending" : "live") : (c.ended ?? "ended")].joined(separator: " · "))
      SequenceView(row: c).padding(.top, 4)
      meta("Message text stays in the agents' own transcripts.").padding(.top, 4)
    } else { overview }
  }

  @ViewBuilder func nodePane(_ id: String) -> some View {
    if let g = groups.first(where: { $0.id == id }) {
      back("Overview", to: .none)
      title(g.label)
      HStack(spacing: 8) {
        StateBarView(bar: g.bar); meta("\(g.count) agents")
        ForEach(appCounts(g.agents), id: \.app) { a in
          HStack(spacing: 3) { AppIconView(app: a.app, size: 15); meta("\(a.count)") }.help(appNames[a.app] ?? a.app)
        }
      }
      meta("\(g.bar.talking) talking · \(g.bar.needs_you) need you · \(g.bar.working) working · \(g.bar.idle) idle · \(g.bar.closed) closed")
      Button(graph.expanded.contains(g.id) ? "Close group" : "Open group") { toggleGroup(g.id) }.controlSize(.small)
      let mine = Set(g.agents.map { $0.address })
      let cs = all.filter { mine.contains($0.from) || mine.contains($0.to) }
      if !cs.isEmpty { Text("CONVERSATIONS").font(.system(size: 10.5, weight: .semibold)).foregroundColor(.secondary).padding(.top, 4) }
      ForEach(cs) { c in pick(c, from: nil) }
    } else if let a = groups.flatMap({ $0.agents }).first(where: { $0.address == id }) {
      back("Overview", to: .none)
      HStack(spacing: 6) { AppIconView(app: a.app, size: 18); title(a.name); if let tag = a.tag { TagView(text: tag, state: a.state) } }
      meta([a.address, appNames[a.app] ?? a.app, a.project].compactMap { $0 }.joined(separator: " · "))
      if let t = a.title { meta("\u{201C}\(t)\u{201D}") }
      if a.state == .needsYou {
        Text("Waiting on you: answer in this agent's own prompt.").font(.system(size: 11.5)).foregroundColor(.abNeed).fixedSize(horizontal: false, vertical: true)
      }
      let cs = all.filter { $0.from == a.address || $0.to == a.address }
      if !cs.isEmpty { Text("CONVERSATIONS").font(.system(size: 10.5, weight: .semibold)).foregroundColor(.secondary).padding(.top, 4) }
      ForEach(cs) { c in pick(c, from: nil) }
      if cs.isEmpty { meta("No conversations today.") }
    } else { overview }
  }
}

// MARK: B3 sequence view

struct SequenceView: View {
  let row: ConversationRow
  let laneInset = 50.0

  /// Long logs fold: the first 3 turns, "⋮ N more turns", the last 4.
  var shown: [SeqEvent] {
    let turns = row.sequence.indices.filter { row.sequence[$0].kind == "turn" }
    guard turns.count > 12 else { return row.sequence }
    let hide = Set(turns[3..<(turns.count - 4)])
    var out: [SeqEvent] = []
    for (i, e) in row.sequence.enumerated() {
      if hide.contains(i) {
        if i == turns[3] { out.append(SeqEvent(kind: "turns", side: "both", label: "⋮ \(hide.count) more turns", time: nil, human: false)) }
        continue
      }
      out.append(e)
    }
    return out
  }

  var body: some View {
    let events = shown
    VStack(spacing: 0) {
      HStack {
        HStack(spacing: 4) { AppIconView(app: appOf(row.from), size: 14); Text(bareName(row.from)).lineLimit(1).truncationMode(.middle) }
          .frame(maxWidth: .infinity)
        HStack(spacing: 4) { AppIconView(app: appOf(row.to), size: 14); Text(bareName(row.to)).lineLimit(1).truncationMode(.middle) }
          .frame(maxWidth: .infinity)
      }
      .font(.system(size: 10.5, weight: .semibold))
      .padding(.leading, 36).padding(.bottom, 4)
      ForEach(Array(events.enumerated()), id: \.offset) { _, e in SeqRow(event: e) }
    }
    .background(alignment: .topLeading) {
      GeometryReader { geo in
        let w = geo.size.width - 36
        let l = 36 + w * 0.25, r = 36 + w * 0.75
        Path { p in p.move(to: CGPoint(x: l, y: 18)); p.addLine(to: CGPoint(x: l, y: geo.size.height)); p.move(to: CGPoint(x: r, y: 18)); p.addLine(to: CGPoint(x: r, y: geo.size.height)) }
          .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
      }
    }
    .accessibilityElement(children: .contain).accessibilityLabel("Sequence of approvals and turns")
  }
}

struct SeqRow: View {
  let event: SeqEvent
  var body: some View {
    HStack(spacing: 0) {
      Text(event.time ?? "").font(.system(size: 9.5, design: .monospaced)).foregroundColor(.secondary).frame(width: 36, alignment: .leading)
      GeometryReader { geo in
        let w = geo.size.width, l = w * 0.25, r = w * 0.75, mid = geo.size.height / 2
        switch event.kind {
        case "turn":
          let toRight = event.side == "from"
          let (x1, x2) = toRight ? (l, r - 6) : (r, l + 6)
          ZStack(alignment: .topLeading) {
            Path { p in p.move(to: CGPoint(x: x1, y: mid + 5)); p.addLine(to: CGPoint(x: x2, y: mid + 5)) }.stroke(Color.primary.opacity(0.8), lineWidth: 1.3)
            Path { p in
              let tip = toRight ? r : l, back = toRight ? r - 7 : l + 7
              p.move(to: CGPoint(x: back, y: mid + 1.5)); p.addLine(to: CGPoint(x: tip, y: mid + 5)); p.addLine(to: CGPoint(x: back, y: mid + 8.5)); p.closeSubpath()
            }.fill(Color.primary.opacity(0.8))
            Text(event.label).font(.system(size: 10)).foregroundColor(.secondary).frame(width: w).position(x: w / 2, y: mid - 5)
          }
        default:
          let human = event.kind == "approval" && event.human
          let fill: Color = human ? Color.abTalk.opacity(0.14) : event.kind == "end" ? Color(nsColor: .quaternaryLabelColor) : event.kind == "approval" ? Color(nsColor: .quaternaryLabelColor).opacity(0.6) : .clear
          Text(event.label).font(.system(size: 10.5)).foregroundColor(human ? .abTalk : .secondary)
            .lineLimit(2).multilineTextAlignment(.center).minimumScaleFactor(0.85)
            .padding(.horizontal, 6).frame(width: w - 4, height: geo.size.height - 4)
            .background(RoundedRectangle(cornerRadius: 5).fill(fill))
            .background(RoundedRectangle(cornerRadius: 5).fill(event.kind == "turns" ? Color.clear : Color(nsColor: .windowBackgroundColor)))
            .position(x: w / 2, y: mid)
        }
      }
    }
    .frame(height: event.kind == "approval" ? 34 : 26)
    .help(event.label)
  }
}

// MARK: window

final class GraphWindowController: NSObject, NSWindowDelegate {
  let store: PanelStore
  let ui = GraphUI()
  private var window: NSWindow?
  init(store: PanelStore) { self.store = store }

  /// Shows the window; the app joins the Dock and ⌘-Tab while it is open, and leaves them when it closes.
  func show() {
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 640), styleMask: [.titled, .closable, .miniaturizable, .resizable],
                       backing: .buffered, defer: false)
      w.title = "AgentBridge"
      w.isReleasedWhenClosed = false
      w.titleVisibility = .hidden
      // an empty unified toolbar only makes the title bar taller; the controls are the accessories below
      w.toolbar = NSToolbar(identifier: "AgentBridgeGraphToolbar")
      w.toolbarStyle = .unifiedCompact
      // the controls sit in the title bar as accessory views: AppKit routes clicks to those (content drawn under a
      // transparent title bar gets none, and NSToolbar items would get macOS 26's glass capsules)
      for (part, attr) in [(GraphToolbar.Part.left, NSLayoutConstraint.Attribute.leading), (.right, .trailing)] {
        let acc = NSTitlebarAccessoryViewController()
        let host = NSHostingView(rootView: GraphToolbar(store: store, ui: ui, defaults: .standard, part: part)
          .padding(.horizontal, part == .left ? 10 : 12).frame(height: 40))
        host.frame.size = host.fittingSize
        acc.view = host
        acc.layoutAttribute = attr
        w.addTitlebarAccessoryViewController(acc)
      }
      w.titlebarAppearsTransparent = true            // the title bar shows the window colour below,
      w.backgroundColor = GraphPalette.chromeNS       // the palette's cool grey instead of the warm system one
      w.contentViewController = NSHostingController(rootView: GraphWindowView(store: store, ui: ui, inTitleBar: true))
      w.setContentSize(NSSize(width: 1180, height: 640))
      w.center()
      w.setFrameAutosaveName("AgentBridgeGraphWindow")
      w.delegate = self
      window = w
    }
    NSApp.setActivationPolicy(.regular)
    installMainMenu()
    NSApp.activate(ignoringOtherApps: true)
    window?.makeKeyAndOrderFront(nil)
    window?.orderFrontRegardless()
    // coming back from .accessory (the window was closed), macOS ignores an activation in the same turn as the policy
    // change: the window opened behind the frontmost app until the Dock icon was clicked. Ask again next turn.
    DispatchQueue.main.async { [weak self] in
      NSApp.activate(ignoringOtherApps: true)
      self?.window?.makeKeyAndOrderFront(nil)
    }
  }

  func windowWillClose(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
  }

  /// A Dock-visible app needs a menu bar: Close, Hide, Quit, and Edit so the filter field takes ⌘C / ⌘V.
  @objc private func zoomIn() { withAnimation(.easeOut(duration: 0.15)) { ui.zoomBy(1.25) } }
  @objc private func zoomOut() { withAnimation(.easeOut(duration: 0.15)) { ui.zoomBy(1 / 1.25) } }
  @objc private func zoomFit() { withAnimation(.easeOut(duration: 0.15)) { ui.resetView() } }
  /// Puts the current grouping's chips back where the layout puts them.
  @objc private func resetLayout() {
    let d = UserDefaults.standard
    let groupBy = d.string(forKey: "agentPanel.groupBy") ?? "project"
    d.set(resetChipSpots(d.string(forKey: chipSpotsKey) ?? "{}", groupBy: groupBy), forKey: chipSpotsKey)
  }

  private func installMainMenu() {
    guard NSApp.mainMenu?.items.isEmpty ?? true else { return }
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let app = NSMenu()
    app.addItem(withTitle: "Hide AgentBridge", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit AgentBridge", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = app
    let fileItem = NSMenuItem(); main.addItem(fileItem)
    let file = NSMenu(title: "File")
    file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    fileItem.submenu = file
    let editItem = NSMenuItem(); main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    let viewItem = NSMenuItem(); main.addItem(viewItem)
    let view = NSMenu(title: "View")
    for (title, key, sel) in [("Zoom In", "+", #selector(zoomIn)), ("Zoom In", "=", #selector(zoomIn)), ("Zoom Out", "-", #selector(zoomOut)), ("Fit Graph", "0", #selector(zoomFit))] {
      let item = NSMenuItem(title: title, action: sel, keyEquivalent: key); item.target = self
      if key == "=" { item.isHidden = true; item.allowsKeyEquivalentWhenHidden = true }   // ⌘= works as ⌘+ too
      view.addItem(item)
    }
    view.addItem(.separator())
    let reset = NSMenuItem(title: "Reset Layout", action: #selector(resetLayout), keyEquivalent: ""); reset.target = self
    view.addItem(reset)
    viewItem.submenu = view
    let winItem = NSMenuItem(); main.addItem(winItem)
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    winItem.submenu = win
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
  }
}
