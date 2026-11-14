import SwiftUI
import AppKit

func bundledPath(_ path: String) -> String {
    path.hasPrefix("/") ? path : (Bundle.main.resourceURL?.appendingPathComponent(path).path ?? path)
}

struct JSONValue: Decodable {
    let raw: Any
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { raw = NSNull() }
        else if let v = try? c.decode(Bool.self) { raw = v }
        else if let v = try? c.decode(Double.self) { raw = v }
        else if let v = try? c.decode(String.self) { raw = v }
        else if let v = try? c.decode([String: JSONValue].self) { raw = v.mapValues(\.raw) }
        else { raw = try c.decode([JSONValue].self).map(\.raw) }
    }
    var text: String { raw as? String ?? "" }
}
struct Project: Decodable, Identifiable {
    let id: String; let name: String; let goal: String; let root: String; let task_count: Int
    var displayName: String {URL(fileURLWithPath:root).lastPathComponent}
}
struct Entry: Decodable, Identifiable {
    let id: String; let project_id: String; let kind: String; let version: Int; let updated_at: String
    let body: [String: JSONValue]; let lease_active: Bool?; let dependencies: [[String: JSONValue]]?
    func text(_ key: String) -> String { body[key]?.text ?? "" }
    var title: String { for key in ["title", "name", "summary", "goal", "actor"] { if !text(key).isEmpty { return text(key) } }; return kind.capitalized }
    var pretty: String { let obj = body.mapValues(\.raw); guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else { return "" }; return String(decoding: data, as: UTF8.self) }
}
struct Event: Decodable, Identifiable {
    let seq: Int; let project_id: String; let record_id: String; let action: String; let actor: String; let at: String
    let record_title: String?; let record_kind: String?
    var id: Int { seq }
}
struct Related: Decodable, Identifiable { let id: String; let kind: String; let title: String? }
struct OperationTask: Decodable, Identifiable { let id: String; let title: String; let progress: String; let state: String; let lease_until: String?; let last_at: String }
struct OperationAgent: Decodable, Identifiable { let actor: String; let last_at: String?; let last_action: String?; let tasks: [OperationTask]; let task_count: Int?; var id: String { actor } }
struct OperationSignal: Decodable, Identifiable { let id: String; let title: String; let reason: String; let severity: String?; var identity: String { id + (severity ?? "ready") } }
struct Operations: Decodable { let agents: [OperationAgent]; let attention: [OperationSignal]; let ready: [OperationSignal]; let totals: [String: Int]; let rules: String }
struct ProjectSearch: Decodable {let query: String; let nodes: [GraphNode]; let total_matches: Int; let omitted_matches: Int}
struct SkillRecommendation: Decodable, Identifiable { let id: String; let version: Int; let title: String; let description: String; let source: String; let score: Int; let reasons: [String] }
struct Snapshot: Decodable {
    let status: String; let error: String?; let captured_at: String; let home: String
    let projects: [Project]; let selected_project_id: String?; let records: [Entry]; let events: [Event]; let counts: [String: Int]; let omitted: Int; let task_summary: [String: Int]?; let related: [Related]?; let focused_record_id: String?; let operations: Operations?; let operations_tasks_omitted: Int?; let graph: GraphPayload?; let working_root: String?; let graph_search: ProjectSearch?; let skill_recommendations: [SkillRecommendation]?
}

@MainActor final class Inspector: ObservableObject {
    static let allProjectsID = "agentbase:all"
    let connections=ConnectionsModel()
    @Published var snapshot: Snapshot?
    @Published var projects: [Project] = []
    @Published var failure: String?
    @Published var paused = false
    @Published var projectID: String?
    @Published var section = "Overview"
    @Published var query = ""
    @Published var taskFilter = "Open"
    @Published var selectedID: String?
    @Published var home: String
    @Published var receivedAt: Date?
    @Published var reconnecting = false
    @Published var includeBackground = false
    @Published var viewMode = "Graph"
    @Published var taskLimit = 200
    @Published var graphQuery = ""
    private var graphSearchTask: Task<Void,Never>?
    @Published var boardQuery = ""
    @Published var boardFilter = "All"
    @Published var history: [String] = []
    @Published var historyIndex = -1
    @Published var graphFocusID: String?
    @Published var graphFocusRequest = UUID()
    @Published var graphFocusPreservesZoom = false
    private var launchRoot: String?
    private let preferences: UserDefaults
    private var process: Process?
    private var readerTask: Task<Void, Never>?
    private var generation = UUID()
    private var buffer = Data()
    private var reconnectTask: Task<Void, Never>?
    private var retryAttempt = 0
    init(preferences: UserDefaults = .standard, args: [String] = CommandLine.arguments, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.preferences = preferences
        let savedView = preferences.string(forKey:"viewMode") ?? "Graph"
        viewMode = ["Graph", "Kanban", "Skills"].contains(savedView) ? savedView : "Graph"
        if let i = args.firstIndex(of: "--home"), args.count > i + 1 { home = args[i + 1] }
        else { home = environment["AGENTBASE_HOME"] ?? preferences.string(forKey: "store") ?? NSHomeDirectory() + "/.local/share/agentbase" }
        if let i = args.firstIndex(of:"--root"), args.count > i+1 { launchRoot = args[i+1] }
        else {launchRoot = environment["AGENTBASE_ROOT"]}
        projectID = launchRoot == nil ? Self.allProjectsID : nil
        connections.setHome(home)
        connections.setWorkspace(launchRoot)
    }
    func start() {
        stop(); paused = false; reconnecting = false
        let token = UUID(); generation = token
        guard let resources = Bundle.main.resourceURL,
              let data = try? Data(contentsOf: resources.appendingPathComponent("runtime.json")),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let node = config["node"] else { failure = "Runtime configuration missing. Rebuild with npm run ui:build."; return }
        let child = Process(); let output = Pipe(); let errors = Pipe()
        child.executableURL = URL(fileURLWithPath: bundledPath(node))
        child.arguments = [resources.appendingPathComponent("bridge/inspector-main.js").path, "--watch", "--home", home] + (projectID.map { ["--project", $0] } ?? []) + (selectedID.map { ["--record", $0] } ?? [])
        child.arguments! += ["--task-limit", String(taskLimit)]
        if let launchRoot {child.arguments! += ["--root",launchRoot]}
        if !normalizedGraphQuery.isEmpty {child.arguments! += ["--search",normalizedGraphQuery]}
        if includeBackground { child.arguments! += ["--include-background"] }
        child.standardOutput = output; child.standardError = errors
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        child.terminationHandler = { [weak self] child in
            errors.fileHandleForReading.readabilityHandler = nil
            let status = child.terminationStatus
            Task { @MainActor [weak self] in guard let self, self.generation == token else { return }; self.readerFailed("Local reader stopped (\(status)).") }
        }
        do {
            try child.run(); process = child
            readerTask = Task.detached(priority:.utility) { [weak self] in
                while !Task.isCancelled {
                    let chunk = output.fileHandleForReading.availableData
                    if chunk.isEmpty { break }
                    await self?.receive(chunk, token:token)
                }
            }
        }
        catch { errors.fileHandleForReading.readabilityHandler = nil; readerFailed("Could not start Node. Rebuild if the Node installation moved.") }
    }
    func receive(_ chunk: Data, token: UUID) {
        guard generation == token, !chunk.isEmpty else { return }
        consume(chunk)
    }
    func consume(_ chunk: Data) {
        buffer.append(chunk)
        if buffer.count > 64 * 1024 * 1024 { readerFailed("Snapshot exceeded the inspector limit."); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.subdata(in: 0..<end); buffer.removeSubrange(0...end)
            do {
                let value = try JSONDecoder().decode(Snapshot.self, from: line)
                let mustPin = projectID == nil && value.selected_project_id != nil
                accept(value)
                if mustPin { start(); return }
            } catch { readerFailed("Could not read local state: \(error.localizedDescription)"); return }
        }
    }
    func accept(_ value: Snapshot) {
        projects = value.projects
        if value.status == "error" { failure = value.error ?? "Local store is unavailable."; return }
        if let pinned = projectID, let incoming = value.selected_project_id, pinned != incoming {
            failure = "Waiting for the selected project's snapshot."; return
        }
        snapshot = value; receivedAt = Date(); failure = nil; retryAttempt = 0; reconnecting = false
        if projectID == nil { projectID = value.selected_project_id }
        connections.setWorkspace(projectID == Self.allProjectsID ? nil : (value.working_root ?? value.projects.first(where:{$0.id == projectID})?.root))
        preferences.set(home, forKey: "store")
        var saved = preferences.dictionary(forKey: "projects") ?? [:]
        if let projectID { saved[home] = projectID }; preferences.set(saved, forKey: "projects")
    }
    func readerFailed(_ message: String) {
        guard !paused else { return }
        stop(); failure = message; reconnecting = true
        retryAttempt += 1
        let delay = min(15, 1 << min(retryAttempt, 4))
        reconnectTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000) } catch { return }
            guard let self, !Task.isCancelled, !self.paused else { return }; self.start()
        }
    }
    func stop() { graphSearchTask?.cancel(); graphSearchTask = nil; generation = UUID(); reconnectTask?.cancel(); reconnectTask = nil; readerTask?.cancel(); readerTask = nil; process?.terminate(); process = nil; buffer = Data(); reconnecting = false }
    func togglePause() { if paused { start() } else { stop(); paused = true } }
    func setViewMode(_ mode: String) { guard ["Graph","Kanban","Skills"].contains(mode) else {return}; viewMode = mode; preferences.set(mode,forKey:"viewMode"); selectedID = nil }
    var kanbanTasks: [Entry] {
        (snapshot?.records ?? []).filter{$0.kind=="task"}.sorted { a,b in
            let pa = (a.body["priority"]?.raw as? NSNumber)?.intValue ?? 2
            let pb = (b.body["priority"]?.raw as? NSNumber)?.intValue ?? 2
            return pa != pb ? pa < pb : (a.updated_at != b.updated_at ? a.updated_at > b.updated_at : a.id < b.id)
        }
    }
    var hasActiveWork: Bool {
        !paused && failure == nil && !reconnecting && (snapshot?.records.contains {
            $0.kind == "task" && $0.text("status") == "in_progress" && $0.lease_active == true
        } ?? false)
    }
    var canLoadMoreTasks: Bool { taskLimit < 1000 && (snapshot?.counts["task"] ?? 0) > kanbanTasks.count }
    func loadMoreTasks() { guard canLoadMoreTasks else {return}; taskLimit = min(1000,taskLimit+200); if !paused {start()} }
    func resetNavigation() { graphSearchTask?.cancel(); graphQuery = ""; taskLimit = 200; history = []; historyIndex = -1; graphFocusID = nil; graphFocusPreservesZoom = false; boardQuery = ""; boardFilter = "All" }
    func selectProject(_ id: String) { launchRoot = nil; resetNavigation(); projectID = id; connections.setWorkspace(id == Self.allProjectsID ? nil : projects.first(where:{$0.id == id})?.root); selectedID = nil; snapshot = nil; query = ""; start() }
    func openRecord(_ id: String, kind: String? = nil) {
        if historyIndex < 0 || history[historyIndex] != id {
            history = Array(history.prefix(historyIndex+1)); history.append(id)
            if history.count > 50 { history.removeFirst(history.count-50) }; historyIndex = history.count-1
        }
        selectRecord(id,kind:kind)
    }
    private func selectRecord(_ id: String, kind: String? = nil) {
        let record = snapshot?.records.first { $0.id == id }
        let sections = ["task": "Tasks", "plan": "Plans", "checkpoint": "Handoffs", "memory": "Memory", "concept": "Memory", "resource": "Memory", "decision": "Memory", "analysis": "Data & analysis", "dataset": "Data & analysis", "session": "Sessions"]
        section = sections[kind ?? record?.kind ?? ""] ?? "Tasks"; query = ""; taskFilter = "All"; selectedID = id
    }
    var canGoBack: Bool { historyIndex > 0 }
    var canGoForward: Bool { historyIndex >= 0 && historyIndex < history.count-1 }
    func goBack() { guard canGoBack else {return}; historyIndex -= 1; selectRecord(history[historyIndex]); if viewMode == "Graph" {graphFocusPreservesZoom = false;graphFocusID = selectedID; graphFocusRequest = UUID()} }
    func goForward() { guard canGoForward else {return}; historyIndex += 1; selectRecord(history[historyIndex]); if viewMode == "Graph" {graphFocusPreservesZoom = false;graphFocusID = selectedID; graphFocusRequest = UUID()} }
    func showInGraph(_ id: String) { graphFocusPreservesZoom = false;graphQuery = ""; setViewMode("Graph"); openRecord(id); graphFocusID = id; graphFocusRequest = UUID() }
    func showOnBoard(_ id: String) {
        setViewMode("Kanban"); boardQuery = ""
        let status = snapshot?.records.first(where:{$0.id == id})?.text("status") ?? ""
        boardFilter = ["done","cancelled"].contains(status) ? "Done" : "All"
        openRecord(id,kind:"task")
    }
    var boardHasFilters: Bool { boardFilter != "All" || !boardQuery.isEmpty }
    func clearBoardFilters() { boardFilter = "All"; boardQuery = "" }
    var boardEmptyExplanation: String? {
        guard boardHasFilters && filteredBoardTasks.isEmpty else {return nil}
        if !boardQuery.isEmpty {return "No tasks match this search."}
        if boardFilter == "Open" {
            if (snapshot?.counts["task"] ?? 0) > kanbanTasks.count {return "No open tasks in the loaded records."}
            if !kanbanTasks.isEmpty {return "All \(kanbanTasks.count) saved tasks are completed or cancelled."}
            return "No open tasks recorded for this project."
        }
        if boardFilter == "Needs attention" {return "No loaded tasks need attention."}
        if boardFilter == "Done" {return "No completed or cancelled tasks in the loaded records."}
        return "No tasks match the current filters."
    }
    var filteredBoardTasks: [Entry] {
        kanbanTasks.filter { task in
            let status = task.text("status"), closed = ["done","cancelled"].contains(status)
            let waiting = (task.dependencies ?? []).contains{$0["status"]?.text != "done"}
            let expired = !task.text("owner").isEmpty && task.lease_active != true && ["in_progress","review"].contains(status)
            let matches = boardFilter == "All" || (boardFilter == "Done" && closed) || (boardFilter == "Open" && !closed) || (boardFilter == "Needs attention" && !closed && (status == "blocked" || status == "review" || waiting || expired))
            return matches && (boardQuery.isEmpty || (task.title + " " + task.text("description") + " " + task.text("owner")).localizedCaseInsensitiveContains(boardQuery))
        }
    }
    var normalizedGraphQuery: String {String(graphQuery.trimmingCharacters(in:.whitespacesAndNewlines).prefix(200))}
    var currentSearch: ProjectSearch? {guard snapshot?.graph_search?.query == normalizedGraphQuery else {return nil};return snapshot?.graph_search}
    var searchMessage: String {
        if paused {return isAllProjects ? "Resume updates to search all projects" : "Resume updates to search the project"}
        if failure != nil {return "Search unavailable · reconnect to retry"}
        guard let search=currentSearch else {return isAllProjects ? "Searching all projects…" : "Searching project…"}
        if search.total_matches == 0 {return isAllProjects ? "No matching saved records" : "No matching project records"}
        return (search.total_matches == 1 ? "1 match" : "\(search.total_matches) matches") + (search.omitted_matches > 0 ? " · showing the first 50" : "")
    }
    func scheduleGraphSearch() {
        graphSearchTask?.cancel()
        guard !paused else {return}
        graphSearchTask=Task { @MainActor [weak self] in
            do {try await Task.sleep(nanoseconds:250_000_000)} catch {return}
            guard let self,!Task.isCancelled,!self.paused else {return};self.graphSearchTask=nil;self.start()
        }
    }
    func chooseSearchResult(_ node: GraphNode) {graphSearchTask?.cancel();graphQuery = "";graphFocusPreservesZoom = true;graphFocusID = node.id;graphFocusRequest = UUID();openRecord(node.id,kind:node.kind)}
    func focusChanged() { if !paused { start() } }
    func chooseStore() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.prompt = "Inspect store"
        if panel.runModal() == .OK, let url = panel.url { launchRoot = nil; resetNavigation(); home = url.path; connections.setHome(home); projectID = preferences.dictionary(forKey: "projects")?[home] as? String; connections.setWorkspace(nil); selectedID = nil; snapshot = nil; projects = []; start() }
    }
    func matchesTask(_ entry: Entry) -> Bool {
        let status = entry.text("status")
        let blocked = !["done", "cancelled"].contains(status) && (status == "blocked" || (entry.dependencies ?? []).contains { $0["status"]?.text != "done" })
        switch taskFilter {
        case "Open": return !["done", "cancelled"].contains(status)
        case "Leased": return entry.lease_active == true
        case "Ready": return status == "ready" && !blocked
        case "Blocked": return blocked
        case "Done": return status == "done"
        default: return true
        }
    }
    var entries: [Entry] {
        let kinds: [String: [String]] = ["Tasks": ["task"], "Memory": ["memory", "decision"], "Handoffs": ["checkpoint"], "Plans": ["plan"], "Data & analysis": ["dataset", "analysis"], "Sessions": ["session"]]
        return (snapshot?.records ?? []).filter { entry in
            (kinds[section]?.contains(entry.kind) ?? true) && (entry.kind != "task" || matchesTask(entry)) && (query.isEmpty || entry.title.localizedCaseInsensitiveContains(query) || entry.pretty.localizedCaseInsensitiveContains(query))
        }
    }
    var isAllProjects: Bool {(projectID ?? snapshot?.selected_project_id) == Self.allProjectsID}
    var currentProject: Project? {projects.first {$0.id == (isAllProjects ? selectedID : (projectID ?? snapshot?.selected_project_id))}}
    func projectName(for id: String) -> String {projects.first {$0.id == id}?.displayName ?? "Project"}
    var projectFolder: String {snapshot?.working_root ?? currentProject?.root ?? ""}
    var projectFolderName: String {URL(fileURLWithPath:projectFolder).lastPathComponent}
    var selectedProjectRoot: Bool {selectedID != nil && selectedID == currentProject?.id}
    var selectedGraphNode: GraphNode? { snapshot?.graph?.nodes.first { $0.id == selectedID } }
    var selected: Entry? { snapshot?.records.first { $0.id == selectedID } }
    func related(to entry: Entry) -> [Related] {
        var result: [Related] = []
        for key in ["task_id", "plan_id", "session_id", "supersedes", "previous_version_id", "parent_id"] {
            let id = entry.text(key); if !id.isEmpty { result.append(Related(id: id, kind: id.components(separatedBy: "_")[0], title: snapshot?.records.first { $0.id == id }?.title)) }
        }
        for key in ["datasets"] { for value in entry.body[key]?.raw as? [[String: Any]] ?? [] { if let id = value["id"] as? String { result.append(Related(id: id, kind: "dataset", title: snapshot?.records.first { $0.id == id }?.title)) } } }
        if snapshot?.focused_record_id == entry.id { result += snapshot?.related ?? [] }
        var seen = Set<String>(); return result.filter { $0.id != entry.id && seen.insert($0.id).inserted }
    }
}

let accent = Color(red: 0.32, green: 0.80, blue: 0.70)
func shortTime(_ value: String) -> String {
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: value)?.formatted(date: .omitted, time: .standard) ?? value
}
func statusColor(_ status: String) -> Color {
    switch status { case "done": return .green; case "in_progress", "review": return accent; case "blocked": return .orange; case "cancelled": return .secondary; default: return .blue }
}
struct MarkdownText: View {
    let markdown: String
    var font: Font = .body

    private var attributedText: AttributedString {
        (try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .full))) ?? AttributedString(markdown)
    }

    var body: some View {
        Text(attributedText).font(font).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).lineSpacing(1)
    }
}
func timeLabel(_ value: String) -> String {
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = format.date(from: value) else { return value }
    return date.formatted(date: .abbreviated, time: .standard)
}
struct StatusBadge: View {
    let value: String
    var body: some View { Text(value.replacingOccurrences(of: "_", with: " ")).font(.caption.weight(.medium)).foregroundStyle(statusColor(value)).padding(.horizontal, 8).padding(.vertical, 4).background(statusColor(value).opacity(0.12), in: Capsule()) }
}
struct AgentBaseCornerLogo: View {
    private static let image = NSImage(contentsOfFile: bundledPath("AgentBaseLogo.png"))
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let isWorking: Bool
    var body: some View {
        if let image = Self.image {
            Image(nsImage:image).resizable().interpolation(.high).frame(width:40,height:40)
                .overlay {
                    if isWorking {
                        if reduceMotion { climber(progress:0.55) }
                        else {
                            TimelineView(.animation(minimumInterval:1.0/15.0)) { timeline in
                                climber(progress:timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy:3.2)/3.2)
                            }
                        }
                    }
                }
                .accessibilityLabel(isWorking ? "AgentBase, task in progress" : "AgentBase logo")
        }
    }
    private func climber(progress: Double) -> some View {
        Canvas { context,size in
            let scale = size.width/40
            let step = sin(progress * .pi * 10) * 0.8 * scale
            let x = (11.5 + progress * 7.5) * scale
            let y = (26.5 - progress * 12) * scale
            let head = CGRect(x:x-1.25*scale,y:y-5.5*scale,width:2.5*scale,height:2.5*scale)
            let ink = Color(red:0.035,green:0.12,blue:0.17)
            let fade = min(1,progress*12,(1-progress)*12)
            context.opacity = fade
            context.fill(Path(ellipseIn:head),with:.color(ink))
            var limbs = Path()
            limbs.move(to:CGPoint(x:x,y:y-2.8*scale)); limbs.addLine(to:CGPoint(x:x,y:y+1.3*scale))
            limbs.move(to:CGPoint(x:x,y:y-1.7*scale)); limbs.addLine(to:CGPoint(x:x-2.2*scale,y:y-0.3*scale+step))
            limbs.move(to:CGPoint(x:x,y:y-1.7*scale)); limbs.addLine(to:CGPoint(x:x+2.2*scale,y:y-2.8*scale-step))
            limbs.move(to:CGPoint(x:x,y:y+1.3*scale)); limbs.addLine(to:CGPoint(x:x-1.8*scale,y:y+3.4*scale-step))
            limbs.move(to:CGPoint(x:x,y:y+1.3*scale)); limbs.addLine(to:CGPoint(x:x+1.8*scale,y:y+3.2*scale+step))
            context.stroke(limbs,with:.color(ink),style:StrokeStyle(lineWidth:1.15*scale,lineCap:.round,lineJoin:.round))
        }
    }
}
private struct OutsideClickMonitor: NSViewRepresentable {
    let panelRect: CGRect
    let onOutsideClick: () -> Void

    func makeNSView(context: Context) -> MonitorView {
        let view = MonitorView()
        view.panelRect = panelRect
        view.onOutsideClick = onOutsideClick
        return view
    }

    func updateNSView(_ view: MonitorView, context: Context) {
        view.panelRect = panelRect
        view.onOutsideClick = onOutsideClick
    }

    final class MonitorView: NSView {
        var panelRect = CGRect.zero
        var onOutsideClick: () -> Void = {}
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil, monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
                guard let self, let window = self.window, event.window === window else { return event }
                let point = self.convert(event.locationInWindow, from: nil)
                let topLeadingPoint = CGPoint(x: point.x, y: self.bounds.height - point.y)
                if !self.panelRect.contains(topLeadingPoint) { self.onOutsideClick() }
                return event
            }
        }

        deinit {
            if let monitor { NSEvent.removeMonitor(monitor) }
        }
    }
}
struct InspectorView: View {
    @StateObject var model = Inspector()
    @State private var expandedDetails=false
    @State private var panelPosition:CGPoint?
    @State private var panelDrag:CGSize = .zero
    private let canvas = Color(red: 0.045, green: 0.055, blue: 0.065)
    private let panel = Color(red: 0.075, green: 0.09, blue: 0.105)
    var body: some View {
        GeometryReader { geometry in
            let floatingSize=CGSize(width:model.selected?.kind == "analysis" ? min(560,geometry.size.width-36) : model.selected?.kind == "task" ? 400 : ["memory","decision"].contains(model.selected?.kind ?? "") ? 510 : 360,height:max(240,min(650,geometry.size.height-100)))
            let panelSize=expandedDetails ? CGSize(width:geometry.size.width-36,height:geometry.size.height-68) : floatingSize
            let compact=DetailPanelPlacement.clamped(panelPosition ?? CGPoint(x:geometry.size.width-floatingSize.width-18,y:34),size:floatingSize,container:geometry.size)
            let location=expandedDetails ? CGPoint(x:18,y:34) : DetailPanelPlacement.clamped(CGPoint(x:compact.x+panelDrag.width,y:compact.y+panelDrag.height),size:floatingSize,container:geometry.size)
            ZStack(alignment: .topLeading) {
                GraphWorkspace(model:model).frame(maxWidth:.infinity,maxHeight:.infinity)
                    .opacity(model.viewMode == "Graph" ? 1 : 0).allowsHitTesting(model.viewMode == "Graph").accessibilityHidden(model.viewMode != "Graph")
                if model.viewMode == "Kanban" {KanbanWorkspace(model:model)}
                SkillWorkspace(model:model).frame(maxWidth:.infinity,maxHeight:.infinity)
                    .opacity(model.viewMode == "Skills" ? 1 : 0).allowsHitTesting(model.viewMode == "Skills").accessibilityHidden(model.viewMode != "Skills")
                if model.selectedID != nil {
                    VStack(spacing:0) {
                        HStack {
                            Button(action:model.goBack) {Image(systemName:"chevron.left").font(.caption)}.buttonStyle(.plain).disabled(!model.canGoBack).help("Previous record")
                            Button(action:model.goForward) {Image(systemName:"chevron.right").font(.caption)}.buttonStyle(.plain).disabled(!model.canGoForward).help("Next record")
                            HStack {
                                Text(model.selected?.text("node_type").isEmpty == false ? model.selected!.text("node_type").capitalized : model.selected?.kind.capitalized ?? (model.selectedProjectRoot ? "Project folder" : "Details")).font(.caption).foregroundStyle(.secondary)
                                Spacer(minLength:8)
                                Image(systemName:"line.3.horizontal").font(.system(size:10)).foregroundStyle(.tertiary)
                            }.contentShape(Rectangle()).help("Drag to move · Double-click to expand or restore").accessibilityLabel("Move details")
                             .overlay(DetailDragHandle(changed:{value in if !expandedDetails {panelDrag=value}},ended:{value in if !expandedDetails {panelPosition=DetailPanelPlacement.clamped(CGPoint(x:compact.x+value.width,y:compact.y+value.height),size:floatingSize,container:geometry.size)};panelDrag = .zero},doubleClick:{panelDrag = .zero;expandedDetails.toggle()}))
                            if let id = model.selectedID {
                                if model.viewMode == "Kanban" { Button {model.showInGraph(id)} label:{Image(systemName:"point.3.connected.trianglepath.dotted").font(.caption)}.buttonStyle(.plain).help("Show in graph") }
                                else if model.selected?.kind == "task" {Button {model.showOnBoard(id)} label:{Image(systemName:"rectangle.split.3x1").font(.caption)}.buttonStyle(.plain).help("Show on board")}
                            }
                            Button {expandedDetails.toggle()} label:{Image(systemName:expandedDetails ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right").font(.caption)}.buttonStyle(.plain).help(expandedDetails ? "Restore details" : "Expand details").accessibilityLabel(expandedDetails ? "Restore details" : "Expand details")
                            Button { model.selectedID = nil } label: { Image(systemName:"xmark").font(.caption) }.buttonStyle(.plain).help("Close details · Escape") }.padding(16)
                        Divider()
                        detail
                    }.frame(width:panelSize.width,height:panelSize.height)
                     .background(.regularMaterial,in:RoundedRectangle(cornerRadius:12))
                     .overlay(RoundedRectangle(cornerRadius:12).stroke(Color.white.opacity(0.08),lineWidth:1))
                     .shadow(color:.black.opacity(0.2),radius:18,y:5).position(x:location.x+panelSize.width/2,y:location.y+panelSize.height/2)
                }
                if let failure = model.failure {
                    VStack { Spacer(); HStack { Image(systemName:"exclamationmark.triangle"); Text(failure + (model.reconnecting ? " Reconnecting…" : "")); Button("Retry") { model.start() } }.font(.caption).foregroundStyle(.orange).padding(12).background(.regularMaterial,in:RoundedRectangle(cornerRadius:10)).padding(.bottom,52) }.frame(maxWidth:.infinity)
                }
            }.background(canvas).overlay {
                if model.selectedID != nil {
                    OutsideClickMonitor(panelRect: CGRect(origin: location, size: panelSize)) { model.selectedID = nil }
                        .frame(maxWidth: .infinity, maxHeight: .infinity).allowsHitTesting(false)
                }
            }.preferredColorScheme(.dark).tint(accent)
                .overlay(alignment:.bottomLeading) {AgentBaseCornerLogo(isWorking:model.hasActiveWork).padding(.leading,18).padding(.bottom,12).allowsHitTesting(false)}
        }.frame(minWidth:880,minHeight:600).ignoresSafeArea()
        .onChange(of:model.selectedID) { _,value in if value==nil {expandedDetails=false;panelDrag = .zero};model.focusChanged() }
        .onChange(of:model.projectID) {_,_ in panelPosition=nil;panelDrag = .zero;expandedDetails=false}
        .onChange(of:model.home) {_,_ in panelPosition=nil;panelDrag = .zero;expandedDetails=false}
        .onAppear { model.start(); model.connections.startup() }
        .onReceive(NotificationCenter.default.publisher(for:NSApplication.willTerminateNotification)) { _ in model.stop() }
    }
    var detail: some View {
            ScrollView {
                if model.selectedProjectRoot, let project = model.currentProject {
                    VStack(alignment:.leading,spacing:20) {
                        Label(model.projectFolderName,systemImage:"folder").font(.title2.bold())
                        detailText("Project",project.name)
                        detailText("Folder",model.projectFolder)
                        detailText("Goal",project.goal)
                        if model.isAllProjects {Button("Open project") {model.selectProject(project.id)}.buttonStyle(.borderedProminent)}
                        Text("\(project.task_count) tasks").font(.caption).foregroundStyle(.secondary)
                        Text("Folder connections show project membership. Other links preserve the recorded relationships between findings, tasks and resources.").font(.caption).foregroundStyle(.secondary)
                        ForEach((model.snapshot?.graph?.edges ?? []).filter {$0.source == project.id && $0.relation == "contains"},id:\.target) {edge in
                            if let node = model.snapshot?.graph?.nodes.first(where:{$0.id == edge.target}) {
                                Button(node.title) {model.openRecord(node.id)}.buttonStyle(.link)
                            }
                        }
                    }.textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading).padding(24)
                } else if let entry = model.selected {
                    VStack(alignment: .leading, spacing: entry.kind == "task" ? 8 : 20) {
                        if entry.kind == "task" {
                            Text(entry.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(.primary).textSelection(.enabled)
                        } else {
                            Text(entry.title).font(.title2.bold()).textSelection(.enabled)
                        }
                        if model.isAllProjects {Button(model.projectName(for:entry.project_id)) {model.selectProject(entry.project_id)}.buttonStyle(.link)}
                        HStack(spacing:10) {
                            if !entry.text("status").isEmpty { StatusBadge(value: entry.text("status")) }
                            Spacer()
                            Text("Updated \(timeLabel(entry.updated_at))").font(.caption).foregroundStyle(.secondary)
                        }
                        if entry.kind == "task" {
                            if !entry.text("description").isEmpty {
                                MarkdownText(markdown:entry.text("description"),font:.system(size:13)).foregroundStyle(.secondary)
                            }
                            taskDetailText("Owner", entry.text("owner"))
                            if !entry.text("plan_id").isEmpty {
                                let planID = entry.text("plan_id")
                                let planTitle = model.snapshot?.records.first(where:{$0.id == planID})?.title ?? model.snapshot?.graph?.nodes.first(where:{$0.id == planID})?.title ?? planID
                                Button("Plan: \(planTitle)") {model.openRecord(planID,kind:"plan")}.buttonStyle(.link)
                            }
                            if !entry.text("parent_task_id").isEmpty {
                                let parentID = entry.text("parent_task_id")
                                let parentTitle = model.snapshot?.records.first(where:{$0.id == parentID})?.title ?? model.snapshot?.graph?.nodes.first(where:{$0.id == parentID})?.title ?? parentID
                                Button("Parent task: \(parentTitle)") {model.openRecord(parentID,kind:"task")}.buttonStyle(.link)
                            }
                            let children = (model.snapshot?.records ?? []).filter {$0.kind == "task" && $0.text("parent_task_id") == entry.id}
                            if !children.isEmpty {
                                VStack(alignment:.leading,spacing:6) {
                                    Text("Subtasks").font(.system(size:13,weight:.semibold))
                                    ForEach(children) { child in
                                        HStack {Button(child.title) {model.openRecord(child.id,kind:"task")}.buttonStyle(.link);Spacer();StatusBadge(value:child.text("status"))}
                                    }
                                }
                            }
                            if !entry.text("lease_expires_at").isEmpty { taskDetailText("Lease", "\(entry.lease_active == true ? "Active" : "Expired") · \(timeLabel(entry.text("lease_expires_at")))") }
                            if !(entry.dependencies ?? []).isEmpty { VStack(alignment: .leading, spacing: 6) { Text("Dependencies").font(.system(size:13,weight:.semibold)); ForEach(Array((entry.dependencies ?? []).enumerated()), id: \.offset) { _, dep in HStack { Button(dep["title"]?.text ?? "Task") { if let id = dep["id"]?.text { model.openRecord(id, kind: "task") } }.buttonStyle(.link); Spacer(); StatusBadge(value: dep["status"]?.text ?? "unknown") } } } }
                            taskDetailText("Progress", entry.text("progress"))
                            if let criteria = entry.body["acceptance"]?.raw as? [String], !criteria.isEmpty {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Acceptance criteria").font(.system(size:13,weight:.semibold))
                                    ForEach(criteria, id: \.self) { criterion in
                                        HStack(alignment:.firstTextBaseline,spacing:8) {
                                            Text("•").font(.system(size:13)).foregroundStyle(.secondary)
                                            MarkdownText(markdown:criterion,font:.system(size:13)).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                            if let completion = entry.body["completion"]?.raw as? [String: Any] {
                                taskDetailText("Completion · agent reported", completion["summary"] as? String ?? "")
                            }
                        }
                        if entry.kind == "checkpoint" { detailText("Handoff", entry.text("summary")); detailText("Next action", entry.text("next_action")); stringList("Remaining", entry.body["remaining"]); stringList("Blockers", entry.body["blockers"]); stringList("Completed", entry.body["completed"]) }
                        if entry.kind == "plan" { detailText("Goal", entry.text("goal")); if let milestones = entry.body["milestones"]?.raw as? [[String: Any]] { ForEach(Array(milestones.enumerated()), id: \.offset) { index, milestone in detailText("\(index + 1). \(milestone["title"] as? String ?? "Milestone")", milestone["acceptance"] as? String ?? "") } }; stringList("Constraints", entry.body["constraints"]); stringList("Open questions", entry.body["open_questions"]) }
                        if entry.kind == "dataset" { detailText("Source", entry.text("source")); resultPreview(entry, isDataset: true) }
                        if !entry.text("node_type").isEmpty { detailText("Resource", entry.text("uri")) }
                        if ["memory", "decision"].contains(entry.kind) { MemoryDetail(model:model,entry:entry).id("\(entry.id)-\(entry.version)") }
                        if entry.kind == "analysis" {AnalysisWorkspace(entry:entry,expanded:expandedDetails).id(entry.id);detailText("SQL",entry.text("sql"));detailText("Interpretation",entry.text("interpretation"))}
                        let graphEdges = (model.snapshot?.graph?.edges ?? []).filter { edge in
                            guard edge.source == entry.id || edge.target == entry.id else {return false}
                            return entry.kind != "task" || !["source","depends_on","child","related","contains"].contains(edge.relation)
                        }
                        if let node = model.selectedGraphNode, !graphEdges.isEmpty {
                            if entry.kind != "task" { Text("\(graphEdges.count) connections").font(.caption).foregroundStyle(.secondary) }
                            VStack(alignment: .leading, spacing: 6) {
                Text(entry.kind == "task" ? "Other connections" : "Graph connections").font(entry.kind == "task" ? .system(size:13,weight:.semibold) : .headline)
                                ForEach(Array(graphEdges.prefix(30).enumerated()), id: \.offset) { _, edge in
                                    let otherID = edge.source == node.id ? edge.target : edge.source
                                    let other = model.snapshot?.graph?.nodes.first { $0.id == otherID }
                                    Button { model.openRecord(otherID) } label: { VStack(alignment: .leading, spacing: 3) { Text(other?.title ?? otherID).lineLimit(2); Text((edge.source == node.id ? "→ " : "← ") + edge.relation.replacingOccurrences(of: "_", with: " ")).font(.caption2).foregroundStyle(.secondary) } }.buttonStyle(.link)
                                }
                            }
                        }
                        if entry.kind != "task", !model.related(to: entry).isEmpty { VStack(alignment: .leading, spacing: 10) { Text("Related records").font(.headline); ForEach(model.related(to: entry)) { related in Button { model.openRecord(related.id, kind: related.kind) } label: { Label(related.title ?? related.id, systemImage: "arrow.up.right.square").lineLimit(2) }.buttonStyle(.link) } } }
                        DisclosureGroup("Full record") {
                            VStack(alignment:.leading,spacing:8) {
                                Text(entry.pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                Text(entry.id).font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary).textSelection(.enabled)
                            }.padding(.top,10)
                        }
                        if entry.kind == "task" { TaskSources(model:model,task:entry).id(entry.id) }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
                } else { ContentUnavailableView(model.selectedID == nil ? "Select a node" : "Record unavailable", systemImage: "cursorarrow.click", description: Text(model.selectedID == nil ? "Click a graph node to inspect its content, linked resources and relationships." : "This record may have been forgotten or may belong to another project." )).padding(.top, 100) }
            }.frame(maxWidth: .infinity)
    }
    func stringList(_ title: String, _ value: JSONValue?) -> some View {
        VStack(alignment: .leading, spacing: 8) { if let items = value?.raw as? [String], !items.isEmpty { Text(title).font(.headline); ForEach(items, id: \.self) { Text("• " + $0).foregroundStyle(.secondary).textSelection(.enabled) } } }
    }
    func cellText(_ value: Any) -> String {
        if value is NSNull { return "null" }
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]) { return String(decoding: data, as: UTF8.self) }
        return String(describing: value)
    }
    func resultPreview(_ entry: Entry, isDataset: Bool) -> some View {
        let columns = entry.body[isDataset ? "schema" : "columns"]?.raw as? [[String: Any]] ?? []
        let rows = entry.body[isDataset ? "sample" : "rows"]?.raw as? [[Any]] ?? []
        return VStack(alignment: .leading, spacing: 10) {
            Text(isDataset ? "Sample rows" : "Saved result preview").font(.headline)
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow { ForEach(Array(columns.enumerated()), id: \.offset) { _, column in Text(column["name"] as? String ?? "Column").font(.caption.bold()).frame(width: 150, alignment: .leading).padding(8).background(accent.opacity(0.12)) } }
                    ForEach(Array(rows.enumerated()), id: \.offset) { index, row in GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, value in Text(cellText(value)).font(.system(.caption, design: .monospaced)).lineLimit(3).frame(width: 150, alignment: .leading).padding(8).background(index.isMultiple(of: 2) ? Color.secondary.opacity(0.04) : Color.clear) } } }
                }.textSelection(.enabled)
            }
            if rows.isEmpty { Text("No saved rows.").font(.caption).foregroundStyle(.secondary) }
        }
    }
    @ViewBuilder func detailText(_ title: String, _ text: String) -> some View {
        if !text.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(text).textSelection(.enabled).foregroundStyle(.secondary)
            }
        }
    }
    @ViewBuilder func taskDetailText(_ title: String, _ text: String) -> some View {
        if !text.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size:12,weight:.semibold)).foregroundStyle(.secondary)
                if title == "Progress" || title.hasPrefix("Completion") {
                    MarkdownText(markdown:text,font:.system(size:13)).foregroundStyle(.secondary)
                } else {
                    Text(text).font(.system(size:13)).textSelection(.enabled).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

#if !INSPECTOR_TESTING
@main struct AgentbaseInspectorApp: App {
    init() {
        if let url=Bundle.main.url(forResource:"AgentBase",withExtension:"icns"), let icon=NSImage(contentsOf:url) {
            NSApplication.shared.applicationIconImage=icon
        }
    }
    var body: some Scene {
        WindowGroup("AgentBase") { InspectorView() }.defaultSize(width: 1440, height: 920).windowStyle(.hiddenTitleBar)
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}

#endif
