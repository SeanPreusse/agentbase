import SwiftUI
import AppKit

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
    @Published var boardFilter = "All tasks"
    @Published var history: [String] = []
    @Published var historyIndex = -1
    @Published var graphFocusID: String?
    @Published var graphFocusRequest = UUID()
    @Published var graphFocusPreservesZoom = false
    private var launchRoot: String?
    private let preferences: UserDefaults
    private var process: Process?
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
    }
    func start() {
        stop(); paused = false; reconnecting = false
        let token = UUID(); generation = token
        guard let resources = Bundle.main.resourceURL,
              let data = try? Data(contentsOf: resources.appendingPathComponent("runtime.json")),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let node = config["node"] else { failure = "Runtime configuration missing. Rebuild with npm run ui:build."; return }
        let child = Process(); let output = Pipe(); let errors = Pipe()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = [resources.appendingPathComponent("bridge/inspector-main.js").path, "--watch", "--home", home] + (projectID.map { ["--project", $0] } ?? []) + (selectedID.map { ["--record", $0] } ?? [])
        child.arguments! += ["--task-limit", String(taskLimit)]
        if let launchRoot {child.arguments! += ["--root",launchRoot]}
        if !normalizedGraphQuery.isEmpty {child.arguments! += ["--search",normalizedGraphQuery]}
        if includeBackground { child.arguments! += ["--include-background"] }
        child.standardOutput = output; child.standardError = errors
        errors.fileHandleForReading.readabilityHandler = { handle in _ = handle.availableData }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            Task { @MainActor in
                guard let self, self.generation == token, !chunk.isEmpty else { return }
                self.buffer.append(chunk)
                if self.buffer.count > 64 * 1024 * 1024 { self.readerFailed("Snapshot exceeded the inspector limit."); return }
                while let end = self.buffer.firstIndex(of: 10) {
                    let line = self.buffer.subdata(in: 0..<end); self.buffer.removeSubrange(0...end)
                    do {
                        let value = try JSONDecoder().decode(Snapshot.self, from: line)
                        let mustPin = self.projectID == nil && value.selected_project_id != nil
                        self.accept(value)
                        if mustPin { self.start(); return }
                    } catch { self.readerFailed("Could not read local state: \(error.localizedDescription)"); return }
                }
            }
        }
        child.terminationHandler = { [weak self] child in
            output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in guard let self, self.generation == token else { return }; self.readerFailed("Local reader stopped (\(child.terminationStatus)).") }
        }
        do { try child.run(); process = child }
        catch { output.fileHandleForReading.readabilityHandler = nil; errors.fileHandleForReading.readabilityHandler = nil; readerFailed("Could not start Node. Rebuild if the Node installation moved.") }
    }
    func accept(_ value: Snapshot) {
        projects = value.projects
        if value.status == "error" { failure = value.error ?? "Local store is unavailable."; return }
        if let pinned = projectID, let incoming = value.selected_project_id, pinned != incoming {
            failure = "Waiting for the selected project's snapshot."; return
        }
        snapshot = value; receivedAt = Date(); failure = nil; retryAttempt = 0; reconnecting = false
        if projectID == nil { projectID = value.selected_project_id }
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
    func stop() { graphSearchTask?.cancel(); graphSearchTask = nil; generation = UUID(); reconnectTask?.cancel(); reconnectTask = nil; process?.terminate(); process = nil; buffer = Data(); reconnecting = false }
    func togglePause() { if paused { start() } else { stop(); paused = true } }
    func setViewMode(_ mode: String) { guard ["Graph","Kanban","Skills"].contains(mode) else {return}; viewMode = mode; preferences.set(mode,forKey:"viewMode"); selectedID = nil }
    var kanbanTasks: [Entry] {
        (snapshot?.records ?? []).filter{$0.kind=="task"}.sorted { a,b in
            let pa = (a.body["priority"]?.raw as? NSNumber)?.intValue ?? 2
            let pb = (b.body["priority"]?.raw as? NSNumber)?.intValue ?? 2
            return pa != pb ? pa < pb : (a.updated_at != b.updated_at ? a.updated_at > b.updated_at : a.id < b.id)
        }
    }
    var canLoadMoreTasks: Bool { taskLimit < 1000 && (snapshot?.counts["task"] ?? 0) > kanbanTasks.count }
    func loadMoreTasks() { guard canLoadMoreTasks else {return}; taskLimit = min(1000,taskLimit+200); if !paused {start()} }
    func resetNavigation() { graphSearchTask?.cancel(); graphQuery = ""; taskLimit = 200; history = []; historyIndex = -1; graphFocusID = nil; graphFocusPreservesZoom = false; boardQuery = ""; boardFilter = "All tasks" }
    func selectProject(_ id: String) { launchRoot = nil; resetNavigation(); projectID = id; selectedID = nil; snapshot = nil; query = ""; start() }
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
    func showOnBoard(_ id: String) { setViewMode("Kanban"); clearBoardFilters(); openRecord(id,kind:"task") }
    var boardHasFilters: Bool { boardFilter != "All tasks" || !boardQuery.isEmpty }
    func clearBoardFilters() { boardFilter = "All tasks"; boardQuery = "" }
    var boardEmptyExplanation: String? {
        guard boardHasFilters && filteredBoardTasks.isEmpty else {return nil}
        if !boardQuery.isEmpty {return "No tasks match this search."}
        if boardFilter == "Open" {
            if (snapshot?.counts["task"] ?? 0) > kanbanTasks.count {return "No open tasks in the loaded records."}
            if !kanbanTasks.isEmpty {return "All \(kanbanTasks.count) saved tasks are completed or cancelled."}
            return "No open tasks recorded for this project."
        }
        if boardFilter == "Needs attention" {return "No loaded tasks need attention."}
        return "No tasks match the current filters."
    }
    var filteredBoardTasks: [Entry] {
        kanbanTasks.filter { task in
            let status = task.text("status"), closed = ["done","cancelled"].contains(status)
            let waiting = (task.dependencies ?? []).contains{$0["status"]?.text != "done"}
            let expired = !task.text("owner").isEmpty && task.lease_active != true && ["in_progress","review"].contains(status)
            let matches = boardFilter == "All tasks" || (boardFilter == "Open" && !closed) || (boardFilter == "Needs attention" && !closed && (status == "blocked" || waiting || expired))
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
        if panel.runModal() == .OK, let url = panel.url { launchRoot = nil; resetNavigation(); home = url.path; projectID = preferences.dictionary(forKey: "projects")?[home] as? String; selectedID = nil; snapshot = nil; projects = []; start() }
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
func timeLabel(_ value: String) -> String {
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = format.date(from: value) else { return value }
    return date.formatted(date: .abbreviated, time: .standard)
}
struct StatusBadge: View {
    let value: String
    var body: some View { Text(value.replacingOccurrences(of: "_", with: " ")).font(.caption.weight(.medium)).foregroundStyle(statusColor(value)).padding(.horizontal, 8).padding(.vertical, 4).background(statusColor(value).opacity(0.12), in: Capsule()) }
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
            let floatingSize=CGSize(width:model.selected?.kind == "analysis" ? min(560,geometry.size.width-36) : 360,height:max(240,min(650,geometry.size.height-100)))
            let panelSize=expandedDetails ? CGSize(width:geometry.size.width-36,height:geometry.size.height-68) : floatingSize
            let compact=DetailPanelPlacement.clamped(panelPosition ?? CGPoint(x:geometry.size.width-floatingSize.width-18,y:34),size:floatingSize,container:geometry.size)
            let location=expandedDetails ? CGPoint(x:18,y:34) : DetailPanelPlacement.clamped(CGPoint(x:compact.x+panelDrag.width,y:compact.y+panelDrag.height),size:floatingSize,container:geometry.size)
            ZStack(alignment: .topLeading) {
                GraphWorkspace(model:model).frame(maxWidth:.infinity,maxHeight:.infinity)
                    .opacity(model.viewMode == "Graph" ? 1 : 0).allowsHitTesting(model.viewMode == "Graph").accessibilityHidden(model.viewMode != "Graph")
                if model.viewMode == "Kanban" {KanbanWorkspace(model:model)}
                if model.viewMode == "Skills" {SkillWorkspace(model:model)}
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
            }.background(canvas).preferredColorScheme(.dark).tint(accent)
        }.frame(minWidth:880,minHeight:600).ignoresSafeArea()
        .onChange(of:model.selectedID) { _,value in if value==nil {expandedDetails=false;panelDrag = .zero};model.focusChanged() }
        .onChange(of:model.projectID) {_,_ in panelPosition=nil;panelDrag = .zero;expandedDetails=false}
        .onChange(of:model.home) {_,_ in panelPosition=nil;panelDrag = .zero;expandedDetails=false}
        .onAppear { model.start() }
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
                    VStack(alignment: .leading, spacing: 20) {
                        Text(entry.title).font(.title2.bold()).textSelection(.enabled)
                        if model.isAllProjects {Button(model.projectName(for:entry.project_id)) {model.selectProject(entry.project_id)}.buttonStyle(.link)}
                        HStack { if !entry.text("status").isEmpty { StatusBadge(value: entry.text("status")) } }
                        Text("Updated \(timeLabel(entry.updated_at))").font(.caption).foregroundStyle(.secondary)
                        if entry.kind == "task" {
                            detailText("Description", entry.text("description")); detailText("Owner", entry.text("owner"))
                            TaskSkillRecommendations(model:model,task:entry)
                            if !entry.text("lease_expires_at").isEmpty { detailText("Lease", "\(entry.lease_active == true ? "Active" : "Expired") · \(timeLabel(entry.text("lease_expires_at")))") }
                            if !(entry.dependencies ?? []).isEmpty { VStack(alignment: .leading, spacing: 8) { Text("Dependencies").font(.headline); ForEach(Array((entry.dependencies ?? []).enumerated()), id: \.offset) { _, dep in HStack { Button(dep["title"]?.text ?? "Task") { if let id = dep["id"]?.text { model.openRecord(id, kind: "task") } }.buttonStyle(.link); Spacer(); StatusBadge(value: dep["status"]?.text ?? "unknown") } } } }
                            detailText("Progress", entry.text("progress"))
                            if let criteria = entry.body["acceptance"]?.raw as? [String] { VStack(alignment: .leading, spacing: 8) { Text("Acceptance criteria").font(.headline); ForEach(criteria, id: \.self) { Text("• " + $0).foregroundStyle(.secondary).textSelection(.enabled) } } }
                            if let completion = entry.body["completion"]?.raw as? [String: Any] {
                                detailText("Completion · agent reported", completion["summary"] as? String ?? "")
                                if let evidence = completion["evidence"] as? [[String: Any]] { VStack(alignment: .leading, spacing: 12) { Text("Evidence").font(.headline); ForEach(Array(evidence.enumerated()), id: \.offset) { _, item in VStack(alignment: .leading, spacing: 5) { Text(item["reference"] as? String ?? "").font(.system(.caption, design: .monospaced)); Text(item["outcome"] as? String ?? "").font(.caption).foregroundStyle(.secondary) }.textSelection(.enabled) } } }
                            }
                        }
                        if entry.kind == "checkpoint" { detailText("Handoff", entry.text("summary")); detailText("Next action", entry.text("next_action")); stringList("Remaining", entry.body["remaining"]); stringList("Blockers", entry.body["blockers"]); stringList("Completed", entry.body["completed"]) }
                        if entry.kind == "plan" { detailText("Goal", entry.text("goal")); if let milestones = entry.body["milestones"]?.raw as? [[String: Any]] { ForEach(Array(milestones.enumerated()), id: \.offset) { index, milestone in detailText("\(index + 1). \(milestone["title"] as? String ?? "Milestone")", milestone["acceptance"] as? String ?? "") } }; stringList("Constraints", entry.body["constraints"]); stringList("Open questions", entry.body["open_questions"]) }
                        if entry.kind == "dataset" { detailText("Source", entry.text("source")); resultPreview(entry, isDataset: true) }
                        if !entry.text("node_type").isEmpty { detailText("Resource", entry.text("uri")) }
                        if ["memory", "decision"].contains(entry.kind) { detailText("Content", entry.text("content")); detailText("Source", entry.text("source")) }
                        if entry.kind == "analysis" {AnalysisWorkspace(entry:entry,expanded:expandedDetails).id(entry.id);detailText("SQL",entry.text("sql"));detailText("Interpretation",entry.text("interpretation"))}
                        if let node = model.selectedGraphNode {
                            Text("\(node.degree) connected nodes").font(.caption).foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Graph connections").font(.headline)
                                ForEach(Array((model.snapshot?.graph?.edges ?? []).filter { $0.source == node.id || $0.target == node.id }.prefix(30).enumerated()), id: \.offset) { _, edge in
                                    let otherID = edge.source == node.id ? edge.target : edge.source
                                    let other = model.snapshot?.graph?.nodes.first { $0.id == otherID }
                                    Button { model.openRecord(otherID) } label: { VStack(alignment: .leading, spacing: 3) { Text(other?.title ?? otherID).lineLimit(2); Text((edge.source == node.id ? "→ " : "← ") + edge.relation.replacingOccurrences(of: "_", with: " ")).font(.caption2).foregroundStyle(.secondary) } }.buttonStyle(.link)
                                }
                            }
                        }
                        if !model.related(to: entry).isEmpty { VStack(alignment: .leading, spacing: 10) { Text("Related records").font(.headline); ForEach(model.related(to: entry)) { related in Button { model.openRecord(related.id, kind: related.kind) } label: { Label(related.title ?? related.id, systemImage: "arrow.up.right.square").lineLimit(2) }.buttonStyle(.link) } } }
                        DisclosureGroup("Full record") { Text(entry.pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 10) }
                        Text(entry.id).font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary).textSelection(.enabled)
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
    func detailText(_ title: String, _ text: String) -> some View { VStack(alignment: .leading, spacing: 8) { if !text.isEmpty { Text(title).font(.headline); Text(text).textSelection(.enabled).foregroundStyle(.secondary) } } }
}

#if !INSPECTOR_TESTING
@main struct AgentbaseInspectorApp: App {
    var body: some Scene {
        WindowGroup("AgentBase") { InspectorView() }.defaultSize(width: 1440, height: 920).windowStyle(.hiddenTitleBar)
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}

#endif
