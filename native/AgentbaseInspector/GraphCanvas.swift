import SwiftUI
import AppKit

struct GraphNode: Decodable, Identifiable {
    let id: String; let kind: String; let title: String; let summary: String; let status: String; let uri: String?; let degree: Int
}
struct GraphEdge: Decodable, Hashable { let source: String; let target: String; let relation: String }
struct UnresolvedGraphLink: Decodable { let source: String; let label: String; let reason: String }
struct GraphPayload: Decodable { let nodes: [GraphNode]; let edges: [GraphEdge]; let omitted_nodes: Int; let total_nodes: Int; let unresolved: [UnresolvedGraphLink]?; let omitted_edges: Int?; let source_truncated: Bool? }
func graphSearch(_ nodes: [GraphNode], query: String) -> [GraphNode] {
    let phrase = query.trimmingCharacters(in:.whitespacesAndNewlines)
    let words = phrase.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    guard !words.isEmpty else {return nodes}
    func score(_ node: GraphNode) -> Int {
        if node.title.compare(phrase,options:[.caseInsensitive,.diacriticInsensitive]) == .orderedSame {return 0}
        if node.title.range(of:phrase,options:[.caseInsensitive,.diacriticInsensitive,.anchored]) != nil {return 1}
        if words.allSatisfy({node.title.localizedStandardContains($0)}) {return 2}
        return 3
    }
    return nodes.filter {node in words.allSatisfy {(node.title + " " + node.summary).localizedStandardContains($0)}}.sorted {
        let a=score($0), b=score($1)
        return a != b ? a < b : ($0.title != $1.title ? $0.title.localizedStandardCompare($1.title) == .orderedAscending : $0.id < $1.id)
    }
}
func graphColor(_ kind: String) -> Color {
    switch kind { case "project": return Color(red:0.88,green:0.90,blue:0.94); case "concept": return Color(red: 0.64, green: 0.60, blue: 0.97); case "task": return accent; case "resource", "dataset": return Color(red: 0.91, green: 0.70, blue: 0.38); case "analysis": return .pink; case "memory", "decision": return Color(red: 0.43, green: 0.70, blue: 0.96); case "plan": return .orange; default: return Color.gray }
}
struct GraphParticle { var point: CGPoint; var velocity: CGPoint = .zero }
private struct IndexedGraphSpring {
    let source: Int
    let target: Int
    let distance: Double
}
struct GraphCameraState: Equatable {
    let scale: CGFloat
    let center: CGPoint
    init(scale: CGFloat, offset: CGPoint) {
        self.scale = scale
        center = CGPoint(x:-offset.x/max(0.001,scale),y:-offset.y/max(0.001,scale))
    }
    init?(stored: [Double]) {
        guard stored.count == 3, stored.allSatisfy(\.isFinite), stored[0] >= 0.12, stored[0] <= 5 else { return nil }
        scale = CGFloat(stored[0]); center = CGPoint(x:stored[1],y:stored[2])
    }
    var offset: CGPoint { CGPoint(x:-center.x*scale,y:-center.y*scale) }
    var stored: [Double] { [Double(scale),Double(center.x),Double(center.y)] }
}
enum GraphCameraPersistence {
    static func key(project: String, localFocus: String? = nil) -> String {
        let base = "agentbase.graph.camera.\(project)"
        return localFocus.map { "\(base).local.\($0)" } ?? base
    }
    static func save(_ camera: GraphCameraState, key: String, defaults: UserDefaults = .standard) {
        defaults.set(camera.stored,forKey:key)
    }
    static func load(key: String, defaults: UserDefaults = .standard) -> GraphCameraState? {
        guard let stored = defaults.array(forKey:key) as? [Double] else { return nil }
        return GraphCameraState(stored:stored)
    }
}
@MainActor final class GraphLayout: ObservableObject {
    @Published var particles: [String: GraphParticle] = [:]
    var nodes: [GraphNode] = []; var edges: [GraphEdge] = []; var heat = 1.0
    private var nodeIndices: [String: Int] = [:]
    private var springs: [IndexedGraphSpring] = []
    var pinned: String?; var gravity = 0.12; var gravityEnabled = true; var repulsion = 2200.0
    @Published var births: [String: TimeInterval] = [:]
    var edgeBirths: [GraphEdge: TimeInterval] = [:]
    func sync(nodes: [GraphNode], edges: [GraphEdge], newIDs: Set<String> = [], now: TimeInterval = Date.timeIntervalSinceReferenceDate) {
        let ids = Set(nodes.map(\.id)); let changed = Set(self.nodes.map(\.id)) != ids || Set(self.edges) != Set(edges)
        let hadExisting = !particles.isEmpty; let previousEdges = Set(self.edges)
        self.nodes = nodes; self.edges = edges
        nodeIndices = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, $0.offset) })
        springs = edges.compactMap { edge in
            guard let source = nodeIndices[edge.source], let target = nodeIndices[edge.target] else { return nil }
            let distance = edge.relation == "contains" ? 180.0 : edge.relation == "child" ? 100.0 : 135.0
            return IndexedGraphSpring(source: source, target: target, distance: distance)
        }
        var updated = particles.filter { ids.contains($0.key) }
        var hierarchy: [String: GraphEdge] = [:]
        var adjacency: [String:[String]] = [:]
        func priority(_ relation: String) -> Int { relation == "child" ? 3 : relation == "plan" ? 2 : relation == "contains" ? 1 : 0 }
        for edge in edges {
            adjacency[edge.source,default:[]].append(edge.target)
            adjacency[edge.target,default:[]].append(edge.source)
            if priority(edge.relation) > 0 {
                let child = edge.relation == "plan" ? edge.source : edge.target
                if priority(edge.relation) > priority(hierarchy[child]?.relation ?? "") { hierarchy[child] = edge }
            }
        }
        var pending = nodes.enumerated().filter { updated[$0.element.id] == nil }
        while !pending.isEmpty {
            let ready = pending.filter { _, node in
                guard node.kind != "project", let edge = hierarchy[node.id] else { return node.kind == "project" }
                return updated[edge.source == node.id ? edge.target : edge.source] != nil
            }
            let batch = ready.isEmpty ? [pending[0]] : ready
            for (i,node) in batch {
                let angle = Double(i) * 2.399963; let radius = 25 + sqrt(Double(i + 1)) * 35
                let parent = hierarchy[node.id].flatMap { edge in
                    updated[edge.source == node.id ? edge.target : edge.source] == nil ? nil : edge
                }
                let connected = (adjacency[node.id] ?? []).compactMap { updated[$0]?.point }
                let point: CGPoint
                if node.kind == "project" && !hadExisting {
                    let projectIndex = nodes[..<i].filter { $0.kind == "project" }.count
                    let projectCount = max(1, nodes.filter { $0.kind == "project" }.count)
                    let projectAngle = 2 * Double.pi * Double(projectIndex) / Double(projectCount)
                    point = projectCount == 1 ? .zero : CGPoint(x: cos(projectAngle) * 180, y: sin(projectAngle) * 180)
                }
                else if let parent {
                    let anchor = updated[parent.source == node.id ? parent.target : parent.source]!.point
                    let distance = parent.relation == "contains" ? 180.0 : parent.relation == "child" ? 100.0 : 135.0
                    point = CGPoint(x:anchor.x + cos(angle)*distance,y:anchor.y + sin(angle)*distance)
                }
                else if !connected.isEmpty {
                    let x = connected.map(\.x).reduce(0,+) / Double(connected.count), y = connected.map(\.y).reduce(0,+) / Double(connected.count)
                    point = CGPoint(x:x + cos(angle)*100,y:y + sin(angle)*100)
                } else { point = CGPoint(x:cos(angle)*radius,y:sin(angle)*radius) }
                updated[node.id] = GraphParticle(point:point)
            }
            let placed = Set(batch.map { $0.element.id })
            pending.removeAll { placed.contains($0.element.id) }
        }
        particles = updated
        births = births.filter { ids.contains($0.key) && now - $0.value < 3 }
        for id in newIDs where ids.contains(id) { births[id] = now }
        let edgeSet = Set(edges)
        edgeBirths = edgeBirths.filter { edgeSet.contains($0.key) && now - $0.value < 3 }
        if hadExisting { for edge in edges where !previousEdges.contains(edge) { edgeBirths[edge] = now } }
        if changed { heat = hadExisting ? max(heat,0.4) : 1 }
    }
    func appearance(_ id: String, now: TimeInterval = Date.timeIntervalSinceReferenceDate) -> Double {
        guard let start = births[id] else { return 1 }; let t = min(1,max(0,(now-start)/0.8)); return t*t*(3-2*t)
    }
    func step() {
        guard heat > 0.015, !nodes.isEmpty else { return }
        var values = nodes.map { particles[$0.id] ?? GraphParticle(point: .zero) }
        var forces = Array(repeating: CGPoint.zero, count: nodes.count)
        for i in nodes.indices {
            for j in nodes.indices where j > i {
                var dx = values[i].point.x - values[j].point.x, dy = values[i].point.y - values[j].point.y
                if abs(dx) + abs(dy) < 0.01 { dx = Double(i + 1) * 0.01; dy = 0.1 }
                let d2 = max(70, dx * dx + dy * dy); let d = sqrt(d2); let force = min(14, repulsion / d2)
                let fx = dx / d * force, fy = dy / d * force
                forces[i].x += fx; forces[i].y += fy; forces[j].x -= fx; forces[j].y -= fy
                let overlap = min(3, max(0, 28 - d) * 0.1)
                forces[i].x += dx / d * overlap; forces[i].y += dy / d * overlap
                forces[j].x -= dx / d * overlap; forces[j].y -= dy / d * overlap
            }
            if gravityEnabled {
                forces[i].x -= values[i].point.x * gravity * (nodes[i].kind == "project" ? 0.12 : 0.04)
                forces[i].y -= values[i].point.y * gravity * (nodes[i].kind == "project" ? 0.12 : 0.04)
            }
        }
        for spring in springs {
            let a = spring.source, b = spring.target
            let dx = values[b].point.x - values[a].point.x, dy = values[b].point.y - values[a].point.y
            let distance = max(1, hypot(dx,dy))
            let force = (distance - spring.distance) * 0.015
            forces[a].x += dx / distance * force; forces[a].y += dy / distance * force
            forces[b].x -= dx / distance * force; forces[b].y -= dy / distance * force
        }
        for i in nodes.indices where nodes[i].id != pinned {
            values[i].velocity.x = (values[i].velocity.x + forces[i].x * heat) * 0.82
            values[i].velocity.y = (values[i].velocity.y + forces[i].y * heat) * 0.82
            values[i].point.x += max(-14, min(14, values[i].velocity.x)); values[i].point.y += max(-14,min(14,values[i].velocity.y))
            if !values[i].point.x.isFinite || !values[i].point.y.isFinite { values[i] = GraphParticle(point: .zero) }
        }
        particles = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($0.element.id, values[$0.offset]) }); heat *= 0.985
    }
    func drag(_ id: String, to point: CGPoint) {
        pinned = id
        particles[id] = GraphParticle(point: point)
        heat = max(0.4,heat)
    }
    func release() { pinned = nil; heat = max(0.4,heat) }
    func resetPositions() {
        let currentNodes = nodes, currentEdges = edges
        particles = [:]; pinned = nil
        sync(nodes: currentNodes, edges: currentEdges)
        heat = 1
    }
    func neighbors(_ id: String, depth: Int = 1) -> Set<String> {
        var visited: Set<String> = [id], frontier = visited
        for _ in 0..<depth { var next = Set<String>(); for edge in edges where edge.relation != "contains" || edge.source == id { if frontier.contains(edge.source) { next.insert(edge.target) }; if frontier.contains(edge.target) { next.insert(edge.source) } }; next.subtract(visited); visited.formUnion(next); frontier = next }
        return visited
    }
}

struct GraphPointerSurface: NSViewRepresentable {
    let down: (CGPoint, Int) -> Void; let moved: (CGPoint) -> Void; let up: () -> Void
    let zoom: (CGFloat, CGPoint) -> Void; let hover: (CGPoint?) -> Void; let key: (String) -> Void
    func makeNSView(context: Context) -> PointerView { let view = PointerView(); updateNSView(view, context: context); return view }
    func updateNSView(_ view: PointerView, context: Context) { view.down = down; view.moved = moved; view.up = up; view.zoom = zoom; view.hover = hover; view.key = key }
    final class PointerView: NSView {
        var down: ((CGPoint, Int) -> Void)?; var moved: ((CGPoint) -> Void)?; var up: (() -> Void)?; var zoom: ((CGFloat,CGPoint) -> Void)?; var hover: ((CGPoint?) -> Void)?; var key: ((String) -> Void)?
        override var isFlipped: Bool { true }
        override var acceptsFirstResponder: Bool { true }
        override func updateTrackingAreas() { super.updateTrackingAreas(); for area in trackingAreas { removeTrackingArea(area) }; addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved,.mouseEnteredAndExited,.activeInKeyWindow,.inVisibleRect], owner: self)) }
        override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); down?(convert(event.locationInWindow, from: nil), event.clickCount) }
        override func mouseDragged(with event: NSEvent) { moved?(convert(event.locationInWindow, from: nil)) }
        override func mouseUp(with event: NSEvent) { up?() }
        override func mouseMoved(with event: NSEvent) { hover?(convert(event.locationInWindow,from:nil)) }
        override func mouseExited(with event: NSEvent) { hover?(nil) }
        override func keyDown(with event: NSEvent) { key?(event.charactersIgnoringModifiers ?? "") }
        override func scrollWheel(with event: NSEvent) { zoom?(exp(event.scrollingDeltaY * (event.hasPreciseScrollingDeltas ? 0.008 : 0.035)), convert(event.locationInWindow, from:nil)) }
        override func magnify(with event: NSEvent) { zoom?(1 + event.magnification, convert(event.locationInWindow,from:nil)) }
    }
}

struct GraphWorkspace: View {
    @ObservedObject var model: Inspector
    @StateObject private var layout = GraphLayout()
    @State private var scale: CGFloat = 1
    @State private var offset: CGPoint = .zero
    @State private var dragNode: String?
    @State private var dragOrigin: CGPoint?
    @State private var startingOffset: CGPoint = .zero
    @State private var hovered: String?
    var query: String {model.graphQuery}
    @State private var local = false
    @State private var labels = true
    @State private var running = true
    @State private var hidden = Set<String>(["session"])
    @State private var handledFocus: UUID?
    @State private var knownIDs = Set<String>()
    @State private var restoredPositionsFor: String?
    @State private var restoredCameraFor: String?
    @State private var lastGraphSignature = ""
    @State private var cachedProjectOwners: [String:String] = [:]
    @State private var cachedProjectColors: [String:Color] = [:]
    @State private var didFit = false
    @State private var didSettleFit = false
    @State private var cameraTouched = false
    @State private var size = CGSize(width: 800,height: 700)
    @FocusState private var searchFocused: Bool
    private let timer = Timer.publish(every: 1.0 / 30, on: .main, in: .common).autoconnect()
    var payload: GraphPayload? { model.snapshot?.graph }
    var graphNodes: [GraphNode] {
        let allowed = (payload?.nodes ?? []).filter { !hidden.contains($0.kind) }
        if local, let id = model.selectedID {
            if model.isAllProjects, payload?.nodes.first(where: { $0.id == id })?.kind == "project" {
                let members = projectMembers(id,edges:payload?.edges ?? [])
                return allowed.filter { members.contains($0.id) }
            }
            let near = neighborhood(id, edges: payload?.edges ?? [])
            return allowed.filter { near.contains($0.id) }
        }
        return allowed
    }
    var graphEdges: [GraphEdge] { let ids = Set(graphNodes.map(\.id)); return (payload?.edges ?? []).filter { ids.contains($0.source) && ids.contains($0.target) } }
    var matches: [GraphNode] {query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty ? graphNodes : model.currentSearch?.nodes ?? []}
    private var graphSignature: String { graphNodes.map(\.id).joined() + graphEdges.map { $0.source + $0.target + $0.relation }.joined() }
    func neighborhood(_ id: String, edges: [GraphEdge]) -> Set<String> { var ids: Set<String> = [id], frontier: Set<String> = [id]; for _ in 0..<2 { var next = Set<String>(); for edge in edges where edge.relation != "contains" || edge.source == id { if frontier.contains(edge.source) { next.insert(edge.target) }; if frontier.contains(edge.target) { next.insert(edge.source) } }; next.subtract(ids); ids.formUnion(next); frontier = next }; return ids }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .topLeading) {
                Canvas { context, canvasSize in draw(context: context,size:canvasSize) }
                    .accessibilityLabel("Knowledge graph: \(graphNodes.count) nodes and \(graphEdges.count) links. Search to select a node.")
                GraphPointerSurface(down: { point,count in
                    cameraTouched = true; dragOrigin = point; startingOffset = offset; dragNode = hit(point)
                    if let id = dragNode { model.openRecord(id); layout.pinned = id; didSettleFit = false; if count == 2 { local = true } }
                }, moved: { point in
                    if let id = dragNode { layout.drag(id,to:world(point)) }
                    else if let origin = dragOrigin { offset = CGPoint(x:startingOffset.x+point.x-origin.x,y:startingOffset.y+point.y-origin.y) }
                }, up: {
                    if dragNode == nil, dragOrigin != nil, hypot(offset.x-startingOffset.x,offset.y-startingOffset.y) < 4 { model.selectedID = nil }
                    dragNode = nil; dragOrigin = nil; layout.release(); savePositions(); saveCamera()
                }, zoom: { factor,anchor in zoom(factor,at:anchor) }, hover: { point in hovered = point.flatMap(hit) }, key: { value in
                    if value == "/" { searchFocused = true }
                    else if value == "+" || value == "=" { zoom(1.2,at:center) }
                    else if value == "-" { zoom(1/1.2,at:center) }
                    else if value == "0" { fit() }
                    else if value == "\u{1b}" { model.selectedID = nil; model.graphQuery = ""; local = false }
                })
                VStack(alignment: .leading,spacing:8) {
                    controls
                    if !model.normalizedGraphQuery.isEmpty {
                        VStack(alignment:.leading,spacing:0) {
                            Text(model.searchMessage).font(.caption2).foregroundStyle(.secondary).padding(10)
                            if !matches.isEmpty {ScrollView {LazyVStack(alignment:.leading,spacing:0) { ForEach(matches) { node in Button {selectSearchResult(node)} label: { VStack(alignment:.leading,spacing:4) {HStack { Circle().fill(graphColor(node.kind)).frame(width:5,height:5); Text(node.title).lineLimit(1); Spacer(); Text(node.kind).foregroundStyle(.secondary) };if !node.summary.isEmpty {Text(node.summary).font(.caption2).foregroundStyle(.secondary).lineLimit(1)} }.font(.caption).padding(10).contentShape(Rectangle()) }.buttonStyle(.plain) }} }.frame(height:min(300,CGFloat(matches.count)*56))}
                        }.frame(width:320).background(.regularMaterial,in:RoundedRectangle(cornerRadius:10))
                    }
                }.padding(.leading,18).padding(.top,34)
                if graphNodes.isEmpty { VStack(spacing:8) { Text("No nodes yet").font(.headline); Text("This graph grows as AgentBase records your project work.").font(.caption).foregroundStyle(.secondary) }.frame(maxWidth:.infinity,maxHeight:.infinity).allowsHitTesting(false) }
                VStack { Spacer(); HStack {
                    HStack(spacing:6) { Circle().fill(model.paused || model.failure != nil ? Color.orange : accent).frame(width:4,height:4); Text("\(graphNodes.count) nodes · \(graphEdges.count) links"); if (payload?.omitted_nodes ?? 0) > 0 { Text("· \(payload!.omitted_nodes) outside view") }; if !(payload?.unresolved?.isEmpty ?? true) { Text("· \(payload!.unresolved!.count) unresolved").foregroundStyle(.orange).help(payload!.unresolved!.map { $0.label }.joined(separator:"\n")) } }.font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    Button(action:fit) { Image(systemName:"arrow.up.left.and.arrow.down.right").frame(width:28,height:28) }.buttonStyle(.plain).foregroundStyle(.secondary).help("Fit graph · 0")
                }.padding(.leading,62).padding(.trailing,18).padding(.vertical,18) }
            }.onAppear { size = geometry.size; syncIfChanged(force:true) }.onChange(of:geometry.size) { _,value in size = value }
        }.onChange(of:model.projectID) { _,_ in knownIDs = []; restoredPositionsFor = nil; restoredCameraFor = nil; didFit = false; didSettleFit = false; cameraTouched = false; offset = .zero; layout.particles = [:]; layout.births = [:]; layout.edgeBirths = [:]; sync() }
         .onChange(of:model.graphQuery) { _,value in if value.count>200 {model.graphQuery=String(value.prefix(200))};model.scheduleGraphSearch() }
         .onChange(of:model.receivedAt) { _,_ in syncIfChanged() }
         .onChange(of:hidden) { _,_ in syncIfChanged() }
         .onChange(of:model.graphFocusRequest) { _,_ in focusRequested() }.onChange(of:model.includeBackground) { _,_ in model.start() }
         .onReceive(timer) { _ in if running && model.viewMode == "Graph" { layout.step(); if layout.heat < 0.08 && !didSettleFit { if !cameraTouched { fit() }; didSettleFit = true; savePositions() } } }
    }
    var controls: some View {
        HStack(spacing:10) {
            Picker("Project",selection:Binding(get:{ model.projectID ?? model.snapshot?.selected_project_id ?? "" },set:{ model.selectProject($0) })) {
                if model.projects.isEmpty { Text("No projects").tag("") }
                Text("All Projects").tag(Inspector.allProjectsID)
                if let id = model.projectID, id != Inspector.allProjectsID, !model.projects.contains(where: { $0.id == id }) { Text("Project unavailable").tag(id) }
                ForEach(model.projects) { Text($0.displayName).tag($0.id) }
            }.labelsHidden().frame(maxWidth:170).help(model.projectFolder)
            WorkspaceViewToggle(model:model)
            if !model.isAllProjects {
                Button {if let id=model.currentProject?.id {model.showInGraph(id)}} label:{Image(systemName:"folder")}.buttonStyle(.plain).help("Project folder: " + model.projectFolder).accessibilityLabel("Project folder")
            }
            RecentChangesButton(model:model)
                    ConnectionsButton(model:model.connections)
            Rectangle().fill(Color.white.opacity(0.12)).frame(width:1,height:16)
            Image(systemName:"magnifyingglass").font(.caption).foregroundStyle(.secondary)
            TextField(model.isAllProjects ? "Search all projects" : "Search project",text:$model.graphQuery).textFieldStyle(.plain).font(.caption).frame(width:140).focused($searchFocused).onSubmit { if let first = model.currentSearch?.nodes.first { selectSearchResult(first) } }.help(model.isAllProjects ? "Search all saved project records · / to focus, Return to open" : "Search saved project text, sources and SQL · / to focus, Return to open")
            if !query.isEmpty {Button {model.graphQuery = ""} label:{Image(systemName:"xmark.circle.fill")}.buttonStyle(.plain).accessibilityLabel("Clear search")}
            Menu {
                Toggle("Local graph",isOn:$local)
                Toggle("Show labels",isOn:$labels)
                Toggle("Node gravity",isOn:Binding(get:{ layout.gravityEnabled },set:{ layout.gravityEnabled = $0; layout.heat = 1 }))
                Toggle("Show background records",isOn:$model.includeBackground)
                Menu("Node types") { ForEach(Array(Set(payload?.nodes.map(\.kind) ?? [])).sorted(),id:\.self) { kind in Toggle(kind.capitalized,isOn:Binding(get:{ !hidden.contains(kind) },set:{ if $0 { hidden.remove(kind) } else { hidden.insert(kind) } })) } }
                Divider()
                Button("Fit graph",action:fit)
                Button("Reset node positions") { UserDefaults.standard.removeObject(forKey:positionStoreKey); layout.resetPositions(); didSettleFit = false; fit() }
                Button(running ? "Pause motion" : "Resume motion") { running.toggle(); if running { layout.heat = 0.4 } }
                Button("Toggle full screen") {NSApp.keyWindow?.toggleFullScreen(nil)}
                Button(model.paused ? "Resume updates" : "Pause updates",action:model.togglePause)
                Button("Reconnect") { model.start() }
                Button("Choose data store…",action:model.chooseStore)
            } label: { Image(systemName:"ellipsis").frame(width:18,height:20) }.menuStyle(.borderlessButton).fixedSize().help("Graph options")
        }.padding(.horizontal,12).padding(.vertical,9).background(.regularMaterial,in:RoundedRectangle(cornerRadius:10))
    }
    var center: CGPoint { CGPoint(x:size.width/2,y:size.height/2) }
    var positionStoreKey: String {
        let project = model.projectID ?? model.snapshot?.selected_project_id ?? "all"
        return local ? "agentbase.graph.positions.\(project).local.\(model.selectedID ?? "selection")" : "agentbase.graph.positions.\(project)"
    }
    var cameraStoreKey: String {
        GraphCameraPersistence.key(project:model.projectID ?? model.snapshot?.selected_project_id ?? "all",localFocus:local ? model.selectedID ?? "selection" : nil)
    }
    func screen(_ point: CGPoint) -> CGPoint { CGPoint(x:point.x*scale+center.x+offset.x,y:point.y*scale+center.y+offset.y) }
    func world(_ point: CGPoint) -> CGPoint { CGPoint(x:(point.x-center.x-offset.x)/scale,y:(point.y-center.y-offset.y)/scale) }
    func zoom(_ factor: CGFloat, at anchor: CGPoint) { cameraTouched = true; let before = world(anchor); scale = min(5,max(0.12,scale*factor)); offset = CGPoint(x:anchor.x-center.x-before.x*scale,y:anchor.y-center.y-before.y*scale); saveCamera() }
    func hit(_ point: CGPoint) -> String? { graphNodes.min { a,b in distance(point,screen(layout.particles[a.id]?.point ?? .zero)) < distance(point,screen(layout.particles[b.id]?.point ?? .zero)) }.flatMap { n in distance(point,screen(layout.particles[n.id]?.point ?? .zero)) < max(12,nodeRadius(n)*scale+5) ? n.id : nil } }
    func distance(_ a: CGPoint,_ b: CGPoint) -> Double { hypot(a.x-b.x,a.y-b.y) }
    func nodeRadius(_ n: GraphNode) -> Double { (n.kind == "project" ? 12 : n.kind == "concept" ? 7.5 : 4.5) + min(8,sqrt(Double(n.degree))*1.4) }
    func sync() {
        let allIDs = Set(payload?.nodes.map(\.id) ?? [])
        let fresh = knownIDs.isEmpty ? Set<String>() : allIDs.subtracting(knownIDs)
        knownIDs.formUnion(allIDs)
        layout.sync(nodes:graphNodes,edges:graphEdges,newIDs:fresh)
        cachedProjectOwners = projectMembership(nodes:graphNodes,edges:graphEdges)
        cachedProjectColors = projectColors(nodes:graphNodes)
        if restoredPositionsFor != positionStoreKey {
            if let saved = UserDefaults.standard.dictionary(forKey:positionStoreKey) as? [String:[Double]] {
                for (id, point) in saved where point.count == 2 && point[0].isFinite && point[1].isFinite && layout.particles[id] != nil {
                    layout.particles[id] = GraphParticle(point:CGPoint(x:point[0],y:point[1]))
                }
                if !saved.isEmpty { layout.heat = max(layout.heat,0.4) }
            }
            restoredPositionsFor = positionStoreKey
        }
        var restoredCamera = false
        if restoredCameraFor != cameraStoreKey {
            if let camera = GraphCameraPersistence.load(key:cameraStoreKey) {
                scale = camera.scale; offset = camera.offset; cameraTouched = true; restoredCamera = true
            }
            restoredCameraFor = cameraStoreKey
        }
        didSettleFit = false
        if restoredCamera { didFit = true }
        else if !didFit && !graphNodes.isEmpty { fit(); didFit = true }
        focusRequested()
    }
    func syncIfChanged(force: Bool = false) {
        let next = graphSignature
        guard force || next != lastGraphSignature else { return }
        lastGraphSignature = next
        sync()
    }
    func savePositions() {
        let saved = Dictionary(uniqueKeysWithValues:layout.particles.map { ($0.key,[Double($0.value.point.x),Double($0.value.point.y)]) })
        if !saved.isEmpty { UserDefaults.standard.set(saved,forKey:positionStoreKey) }
    }
    func saveCamera() {
        GraphCameraPersistence.save(GraphCameraState(scale:scale,offset:offset),key:cameraStoreKey)
    }
    func projectMembers(_ projectID: String, edges: [GraphEdge]) -> Set<String> {
        var adjacency: [String:[String]] = [:]
        for edge in edges {
            if edge.relation == "contains" { adjacency[edge.source,default:[]].append(edge.target) }
            else {
                adjacency[edge.source,default:[]].append(edge.target)
                adjacency[edge.target,default:[]].append(edge.source)
            }
        }
        var members: Set<String> = [projectID]
        var frontier = [projectID]
        while let current = frontier.popLast() {
            for next in adjacency[current] ?? [] where members.insert(next).inserted { frontier.append(next) }
        }
        return members
    }
    func projectMembership(nodes: [GraphNode], edges: [GraphEdge]) -> [String:String] {
        var adjacency: [String:[String]] = [:]
        for edge in edges {
            if edge.relation == "contains" { adjacency[edge.source,default:[]].append(edge.target) }
            else {
                adjacency[edge.source,default:[]].append(edge.target)
                adjacency[edge.target,default:[]].append(edge.source)
            }
        }
        let roots = Set(nodes.filter { $0.kind == "project" }.map(\.id))
        var owners: [String:String] = [:]
        for projectID in roots {
            var visited: Set<String> = [projectID]
            var frontier = [projectID]
            while !frontier.isEmpty {
                let current = frontier.removeLast()
                for next in adjacency[current] ?? [] where !roots.contains(next) && visited.insert(next).inserted {
                    owners[next] = projectID
                    frontier.append(next)
                }
            }
            owners[projectID] = projectID
        }
        return owners
    }
    func projectColors(nodes: [GraphNode]) -> [String:Color] {
        Dictionary(uniqueKeysWithValues:nodes.filter { $0.kind == "project" }.map { node in
            var hash: UInt64 = 14695981039346656037
            for byte in node.id.utf8 { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
            let hue = Double(hash % 360) / 360
            return (node.id,Color(hue:hue,saturation:0.64,brightness:0.94))
        })
    }
    func focusRequested() {
        guard handledFocus != model.graphFocusRequest, let id = model.graphFocusID, let point = layout.particles[id]?.point else {return}
        handledFocus = model.graphFocusRequest; cameraTouched = true
        if !model.graphFocusPreservesZoom {scale = max(0.7,min(1.6,scale))}; offset = CGPoint(x:-point.x*scale,y:-point.y*scale); hovered = nil; saveCamera()
    }
    func select(_ node: GraphNode) { model.openRecord(node.id); if let p = layout.particles[node.id]?.point { offset = CGPoint(x:-p.x*scale,y:-p.y*scale); cameraTouched = true; saveCamera() } }
    func selectSearchResult(_ node: GraphNode) { hidden.remove(node.kind); searchFocused = false; model.chooseSearchResult(node) }
    func fit() {
        let points = Array(layout.particles.values.map(\.point)); guard !points.isEmpty else { return }
        let minX = points.map(\.x).min()!, maxX = points.map(\.x).max()!, minY = points.map(\.y).min()!, maxY = points.map(\.y).max()!
        scale = max(0.12,min(2,min((size.width-160)/max(100,maxX-minX),(size.height-150)/max(100,maxY-minY))))
        offset = CGPoint(x:-(minX+maxX)/2*scale,y:-(minY+maxY)/2*scale)
        saveCamera()
    }
    func draw(context: GraphicsContext, size: CGSize) {
        let selected = hovered ?? model.selectedID
        let selectedProject = selected.flatMap { id in graphNodes.first(where: { $0.id == id && $0.kind == "project" })?.id }
        let owners = cachedProjectOwners, colors = cachedProjectColors
        let neighbors = selectedProject.map { root in Set(owners.filter { $0.value == root }.map(\.key)) } ?? selected.map { layout.neighbors($0) } ?? []
        let matching = Set(matches.map(\.id)); let ctx = context
        let now = Date.timeIntervalSinceReferenceDate
        for edge in graphEdges {
            guard let a = layout.particles[edge.source]?.point,let b = layout.particles[edge.target]?.point else { continue }
            let p = screen(a), q = screen(b); var path = Path(); path.move(to:p); path.addLine(to:q)
            let active = selected == edge.source || selected == edge.target || (selectedProject != nil && neighbors.contains(edge.source) && neighbors.contains(edge.target))
            let sameProject = owners[edge.source] != nil && owners[edge.source] == owners[edge.target]
            let fade = layout.edgeBirths[edge].map { min(1,max(0,(now-$0)/0.8)) } ?? 1
            let edgeColor = active ? accent : sameProject ? (colors[owners[edge.source]!] ?? accent) : .white
            let edgeOpacity = active ? 0.65 : sameProject ? (edge.relation == "child" ? 0.28 : 0.16) : (edge.relation == "child" ? 0.23 : 0.09)
            ctx.stroke(path,with:.color(edgeColor.opacity(edgeOpacity*fade)),lineWidth:active ? 1.4 : 0.75)
            if edge.relation == "child", scale > 0.45 { let t = atan2(q.y-p.y,q.x-p.x), tip = CGPoint(x:q.x-cos(t)*12*scale,y:q.y-sin(t)*12*scale); var arrow = Path(); arrow.move(to:CGPoint(x:tip.x-cos(t-0.5)*6,y:tip.y-sin(t-0.5)*6)); arrow.addLine(to:tip); arrow.addLine(to:CGPoint(x:tip.x-cos(t+0.5)*6,y:tip.y-sin(t+0.5)*6)); ctx.stroke(arrow,with:.color(Color.white.opacity(0.35)),lineWidth:1) }
        }
        var labelBounds: [CGRect] = []
        let ordered = graphNodes.sorted { a,b in
            if (a.id == selected) != (b.id == selected) { return a.id == selected }
            if (a.kind == "project") != (b.kind == "project") {return a.kind == "project"}
            if (a.kind == "concept") != (b.kind == "concept") { return a.kind == "concept" }
            return a.degree > b.degree
        }
        for node in ordered {
            guard let position = layout.particles[node.id]?.point else { continue }; let p = screen(position), growth = layout.appearance(node.id,now:now), radius = nodeRadius(node)*scale*(0.25+0.75*growth)
            let active = node.id == selected, related = neighbors.contains(node.id)
            let opacity: Double = !query.isEmpty && !matching.contains(node.id) ? 0.12 : selected != nil && !related ? 0.23 : 1
            let color = (node.kind == "project" ? (colors[node.id] ?? accent) : graphColor(node.kind)).opacity(opacity*growth)
            if let birth = layout.births[node.id], now-birth < 2.4 { let age = max(0,now-birth); let r = radius + 4 + age*9; ctx.stroke(Path(ellipseIn:CGRect(x:p.x-r,y:p.y-r,width:r*2,height:r*2)),with:.color(graphColor(node.kind).opacity((1-age/2.4)*0.5)),lineWidth:1) }
            if active { ctx.stroke(Path(ellipseIn:CGRect(x:p.x-radius-5,y:p.y-radius-5,width:radius*2+10,height:radius*2+10)),with:.color(accent.opacity(0.55)),lineWidth:1) }
            if node.kind == "project" {ctx.stroke(Path(ellipseIn:CGRect(x:p.x-radius-4,y:p.y-radius-4,width:radius*2+8,height:radius*2+8)),with:.color(color.opacity(0.35)),lineWidth:1)}
            else if let owner = owners[node.id] {ctx.stroke(Path(ellipseIn:CGRect(x:p.x-radius-2,y:p.y-radius-2,width:radius*2+4,height:radius*2+4)),with:.color((colors[owner] ?? accent).opacity(opacity*0.5*growth)),lineWidth:1)}
            ctx.fill(Path(ellipseIn:CGRect(x:p.x-radius,y:p.y-radius,width:radius*2,height:radius*2)),with:.color(color))
            if labels && (scale > 0.62 || active || node.kind == "concept" || node.kind == "project" || related) {
                let maxWidth = min(360,max(120,size.width-24))
                let title = active ? wrapTitle(node.title,width:maxWidth) : (node.title.count > 42 ? String(node.title.prefix(40))+"…" : node.title)
                let label = ctx.resolve(Text(title).font(.system(size:active ? 12 : 10,weight:active ? .semibold : .regular)).foregroundColor(Color.white.opacity(opacity*0.85)))
                let measured = label.measure(in: CGSize(width:maxWidth,height:max(40,size.height)))
                let inset: CGFloat = active ? 8 : 0
                let labelX = min(max(p.x,measured.width/2+inset+8),size.width-measured.width/2-inset-8)
                let below = p.y+radius+12
                let preferredY = below+measured.height+inset*2 < size.height-8 ? below : p.y-radius-12-measured.height-inset*2
                let labelY = min(max(8,preferredY),max(8,size.height-measured.height-inset*2-8))
                let bounds = CGRect(x:labelX-measured.width/2-inset,y:labelY,width:measured.width+inset*2,height:measured.height+inset*2)
                if active || node.kind == "project" || !labelBounds.contains(where: { $0.intersects(bounds) }) {
                    if active {
                        ctx.fill(Path(roundedRect:bounds,cornerSize:CGSize(width:6,height:6)),with:.color(Color.black.opacity(0.82)))
                        ctx.stroke(Path(roundedRect:bounds,cornerSize:CGSize(width:6,height:6)),with:.color(accent.opacity(0.35)),lineWidth:0.8)
                    }
                    ctx.draw(label,at:CGPoint(x:labelX,y:labelY+inset),anchor:.top); labelBounds.append(bounds)
                }
            }
        }
    }
    func wrapTitle(_ title:String,width:CGFloat) -> String {
        let limit=max(12,Int(width/7))
        var lines:[String]=[],line=""
        for character in title {
            if character == "\n" { lines.append(line); line=""; continue }
            if line.count >= limit && character == " " { lines.append(line); line=""; continue }
            if line.count >= limit { lines.append(line); line="" }
            line.append(character)
        }
        if !line.isEmpty || lines.isEmpty {lines.append(line)}
        return lines.joined(separator:"\n")
    }
}
