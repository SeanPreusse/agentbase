import Foundation

@main struct InspectorChecks {
    @MainActor static func main() async throws {
        let suite = "dev.agentbase.inspector.checks.\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let model = Inspector(preferences: preferences, args: [], environment: [:])
        func snapshotData(_ project: String = "project_a", status: String = "connected", completedOnly: Bool = false, totalTasks: Int = 3, searchQuery: String? = nil) throws -> Data {
            var value: [String: Any] = ["status": status, "error": "Synthetic unavailable store", "captured_at": "2026-11-12T00:00:00.000Z", "home": model.home,
                "projects": [["id": "project_a", "name": "A", "goal": "A", "root": "/a", "task_count": 3], ["id": "project_b", "name": "B", "goal": "B", "root": "/b", "task_count": 0]],
                "operations": ["agents": [["actor": "agent-a", "tasks": [["id": "task_a", "title": "Active work", "progress": "Running tests", "state": "Claimed", "last_at": "now"]], "task_count": 1]], "attention": [["id": "task_b", "title": "Dependent", "reason": "Waiting for work", "severity": "blocked"], ["id": "task_b", "title": "Dependent", "reason": "Lease expired", "severity": "expired"]], "ready": [], "totals": ["owned": 1], "rules": "Recorded state"],
                "selected_project_id": project, "counts": ["task": totalTasks], "omitted": 0, "events": [],
                "records": [
                    ["id": "task_a", "kind": "task", "version": 1, "updated_at": "now", "lease_active": true, "dependencies": [], "body": ["title": "Active work", "status": completedOnly ? "done" : "in_progress", "owner": "agent-a"]],
                    ["id": "task_b", "kind": "task", "version": 1, "updated_at": "now", "lease_active": false, "dependencies": [["id": "task_a", "title": "Active work", "status": "in_progress"]], "body": ["title": "Dependent", "status": completedOnly ? "done" : "ready", "plan_id": "plan_a"]],
                    ["id": "task_c", "kind": "task", "version": 1, "updated_at": "now", "lease_active": false, "dependencies": [], "body": ["title": "Finished", "status": "done"]],
                    ["id": "plan_a", "kind": "plan", "version": 1, "updated_at": "now", "body": ["goal": "Shared plan"]]
                ]]
            if let searchQuery {value["graph_search"] = ["query":searchQuery,"nodes":[],"total_matches":0,"omitted_matches":0]}
            if var records = value["records"] as? [[String: Any]] {
                for index in records.indices { records[index]["project_id"] = project }
                value["records"] = records
            }
            return try JSONSerialization.data(withJSONObject: value)
        }
        func snapshot(_ project: String = "project_a", status: String = "connected", completedOnly: Bool = false, totalTasks: Int = 3, searchQuery: String? = nil) throws -> Snapshot {
            try JSONDecoder().decode(Snapshot.self, from:snapshotData(project,status:status,completedOnly:completedOnly,totalTasks:totalTasks,searchQuery:searchQuery))
        }
        let stream=Inspector(preferences:preferences,args:[],environment:[:])
        stream.projectID = "project_a"
        let firstFrame=try snapshotData(), secondFrame=try snapshotData(completedOnly:true)
        var wire=Data(); wire.append(firstFrame); wire.append(10); wire.append(secondFrame); wire.append(10)
        stream.consume(Data(wire.prefix(firstFrame.count/2)))
        precondition(stream.snapshot == nil && stream.failure == nil, "A partial reader chunk waits for its newline")
        stream.consume(Data(wire.dropFirst(firstFrame.count/2)))
        precondition(stream.snapshot?.records.first(where:{$0.id == "task_a"})?.text("status") == "done" && stream.failure == nil, "Ordered chunks decode consecutive snapshots")
        model.projectID = "project_a"; model.accept(try snapshot()); model.section = "Tasks"
        precondition(model.boardFilter == "All" && model.filteredBoardTasks.count == 3, "All is the default task view")
        precondition(model.connections.workspaceRoot == "/a", "Connection checks use the selected project root")
        precondition(model.hasActiveWork, "An in-progress task with an active lease animates the corner icon")
        precondition(model.projectID == "project_a")
        func memoryEntry(_ id:String,_ title:String,_ content:String) throws -> Entry {
            try JSONDecoder().decode(Entry.self,from:JSONSerialization.data(withJSONObject:["id":id,"project_id":"project_a","kind":"memory","version":1,"updated_at":"2026-11-14T00:00:00.000Z","body":["title":title,"content":content,"source":"fixture","status":"active"]]))
        }
        let memoryA=try memoryEntry("memory_a","Invoice identity","Customer and invoice number")
        let memoryB=try memoryEntry("memory_b","Other title","Customer and invoice number")
        let memoryC=try memoryEntry("memory_c","Invoice identity","Invoice number only")
        precondition(memoryComparisons(for:memoryA,among:[memoryA,memoryB,memoryC]).map(\.label) == ["Same content","Same title, different content"],"Memory review distinguishes duplicates from possible contradictions")
        precondition(model.snapshot?.operations?.agents.first?.tasks.first?.progress == "Running tests")
        precondition(Set(model.snapshot!.operations!.attention.map(\.identity)).count == 2, "Multiple signals on one task retain distinct identities")
        precondition(model.entries.count == 2, "Open hides finished work")
        model.taskFilter = "Leased"; precondition(model.entries.map(\.id) == ["task_a"])
        model.taskFilter = "Ready"; precondition(model.entries.isEmpty, "Dependencies block ready work")
        model.taskFilter = "Blocked"; precondition(model.entries.map(\.id) == ["task_b"])
        model.taskFilter = "Done"; precondition(model.entries.map(\.id) == ["task_c"])
        model.query = "nonexistent"; model.openRecord("task_b")
        precondition(model.query.isEmpty && model.taskFilter == "All" && model.selected?.id == "task_b")
        let links = model.related(to: model.selected!); precondition(links.first?.id == "plan_a")
        model.openRecord("plan_a", kind: "plan"); precondition(model.section == "Plans")
        model.openRecord("concept_from_search", kind: "concept"); precondition(model.section == "Memory", "Concept search results open the memory panel")
        model.accept(try snapshot("project_b")); precondition(model.snapshot?.selected_project_id == "project_a", "Another project's activity cannot change selection")
        model.accept(try snapshot(status: "error")); precondition(model.snapshot?.records.count == 4 && model.failure != nil, "Keep the last good view on store errors")
        precondition(!model.hasActiveWork, "A disconnected reader cannot show live work")
        let restored = Inspector(preferences: preferences, args: [], environment: [:]); precondition(restored.projectID == Inspector.allProjectsID && restored.home == model.home)
        model.readerFailed("Synthetic reader crash"); precondition(model.reconnecting && model.snapshot?.records.count == 4)
        model.togglePause(); precondition(model.paused && !model.reconnecting && !model.hasActiveWork)
        try await Task.sleep(nanoseconds: 2_200_000_000)
        precondition(model.paused && model.failure == "Synthetic reader crash", "Pause cancels reconnect")
        let layout = GraphLayout()
        let hierarchyLayout = GraphLayout()
        let hierarchyNodes = [
            GraphNode(id:"child",kind:"task",title:"Subtask",summary:"",status:"ready",uri:nil,degree:1),
            GraphNode(id:"parent",kind:"task",title:"Parent task",summary:"",status:"ready",uri:nil,degree:2),
            GraphNode(id:"root",kind:"project",title:"Project",summary:"",status:"",uri:nil,degree:1)
        ]
        let hierarchyEdges = [GraphEdge(source:"root",target:"parent",relation:"contains"),GraphEdge(source:"parent",target:"child",relation:"child")]
        hierarchyLayout.sync(nodes:hierarchyNodes,edges:hierarchyEdges)
        precondition(abs(hypot(hierarchyLayout.particles["parent"]!.point.x,hierarchyLayout.particles["parent"]!.point.y)-180) < 0.001, "A top-level task starts at the project radius")
        precondition(abs(hypot(hierarchyLayout.particles["child"]!.point.x-hierarchyLayout.particles["parent"]!.point.x,hierarchyLayout.particles["child"]!.point.y-hierarchyLayout.particles["parent"]!.point.y)-100) < 0.001, "A subtask starts near its parent even when it arrives first")
        let savedCamera = GraphCameraState(scale:1.35,offset:CGPoint(x:-220,y:95))
        let restoredCamera = GraphCameraState(stored:savedCamera.stored)
        precondition(restoredCamera?.scale == savedCamera.scale && restoredCamera?.offset == savedCamera.offset, "Camera zoom and world center survive persistence")
        precondition(GraphCameraState(stored:[.nan,0,0]) == nil, "Invalid persisted camera state is ignored")
        let cameraSuite = "dev.agentbase.inspector.camera.\(UUID().uuidString)"
        let cameraDefaults = UserDefaults(suiteName:cameraSuite)!
        defer { cameraDefaults.removePersistentDomain(forName:cameraSuite) }
        let allCameraKey = GraphCameraPersistence.key(project:"all")
        let localCameraKey = GraphCameraPersistence.key(project:"all",localFocus:"project_a")
        GraphCameraPersistence.save(savedCamera,key:allCameraKey,defaults:cameraDefaults)
        precondition(GraphCameraPersistence.load(key:allCameraKey,defaults:cameraDefaults) == savedCamera, "Camera is saved and restored for its view")
        precondition(localCameraKey != allCameraKey && GraphCameraPersistence.load(key:localCameraKey,defaults:cameraDefaults) == nil, "Local focus camera is isolated from All Projects")
        precondition(GraphCameraPersistence.key(project:"project_a") != allCameraKey, "Project cameras are scoped independently")
        let graphNodes = (0..<20).map { GraphNode(id: "n\($0)", kind: $0 == 0 ? "concept" : "task", title: "Node \($0)", summary: "", status: "", uri: nil, degree: 1) }
        let graphEdges = (0..<19).map { GraphEdge(source: "n\($0)", target: "n\($0 + 1)", relation: "child") }
        layout.sync(nodes: graphNodes, edges: graphEdges)
        for _ in 0..<300 { layout.step() }
        precondition(layout.particles.values.allSatisfy { $0.point.x.isFinite && $0.point.y.isFinite }, "Force layout remains finite")
        let overviewNodes = ["agentbase2", "data-platform", "salesforce"].map { GraphNode(id: $0, kind: "project", title: $0, summary: "", status: "", uri: nil, degree: 1) } + (0..<8).map { GraphNode(id: "main-\($0)", kind: "task", title: "Main \($0)", summary: "", status: "", uri: nil, degree: 1) } + ["data-task", "sales-task"].map { GraphNode(id: $0, kind: "task", title: $0, summary: "", status: "", uri: nil, degree: 1) }
        let overviewEdges = (0..<8).map { GraphEdge(source: "agentbase2", target: "main-\($0)", relation: "contains") } + [GraphEdge(source: "data-platform", target: "data-task", relation: "contains"), GraphEdge(source: "salesforce", target: "sales-task", relation: "contains")]
        let overviewLayout = GraphLayout(); overviewLayout.sync(nodes: overviewNodes, edges: overviewEdges)
        let initialOverview = overviewLayout.particles
        for root in overviewNodes.filter({ $0.kind == "project" }) {
            precondition(abs(hypot(initialOverview[root.id]!.point.x, initialOverview[root.id]!.point.y) - 180) < 0.001, "All project roots start together around the shared graph")
        }
        for _ in 0..<100 { overviewLayout.step() }
        precondition(Set(overviewLayout.particles.keys) == Set(initialOverview.keys), "Shared overview keeps every project node")
        precondition(overviewLayout.particles.values.allSatisfy { $0.point.x.isFinite && $0.point.y.isFinite }, "Shared overview forces remain finite")
        precondition(overviewLayout.particles.contains { entry in entry.value.point != initialOverview[entry.key]?.point }, "All Projects uses the active force simulation")
        let leafHome = overviewLayout.particles["main-0"]!.point
        let displaced = CGPoint(x:leafHome.x+220,y:leafHome.y+160)
        overviewLayout.drag("main-0",to:displaced); overviewLayout.release()
        for _ in 0..<110 { overviewLayout.step() }
        let settled = overviewLayout.particles["main-0"]!.point
        precondition(hypot(settled.x-leafHome.x,settled.y-leafHome.y) < hypot(displaced.x-leafHome.x,displaced.y-leafHome.y), "Shared gravity and links pull a moved node back toward the graph")
        let gravityOff = GraphLayout()
        let isolated = GraphNode(id:"isolated",kind:"task",title:"Isolated",summary:"",status:"",uri:nil,degree:0)
        gravityOff.sync(nodes:[isolated],edges:[]); gravityOff.gravityEnabled = false
        let gravityOffPoint = CGPoint(x:1000,y:1000)
        gravityOff.drag("isolated",to:gravityOffPoint); gravityOff.release()
        for _ in 0..<30 { gravityOff.step() }
        precondition(gravityOff.particles["isolated"]!.point == gravityOffPoint, "Turning gravity off leaves an isolated moved node in place")
        let rootBefore = overviewLayout.particles["salesforce"]!.point
        let memberBefore = overviewLayout.particles["sales-task"]!.point
        overviewLayout.drag("salesforce",to:CGPoint(x:rootBefore.x+50,y:rootBefore.y+40)); overviewLayout.release()
        precondition(overviewLayout.particles["sales-task"]!.point == memberBefore, "Project root drag uses the shared node behavior")
        overviewLayout.resetPositions()
        precondition(overviewLayout.particles["salesforce"]!.point == initialOverview["salesforce"]!.point, "Reset restores the compact shared graph layout")
        layout.drag("n0", to: CGPoint(x: 200, y: 300)); layout.step()
        precondition(layout.particles["n0"]?.point == CGPoint(x: 200,y: 300), "Dragged node stays pinned during physics")
        precondition(layout.neighbors("n0", depth: 2) == Set(["n0","n1","n2"]), "Local graph obeys hop depth")
        let workspace = GraphWorkspace(model: model)
        precondition(workspace.neighborhood("n0", edges: graphEdges) == Set(["n0","n1","n2"]), "Local canvas does not leak across a chain")
        let overviewMembers = workspace.projectMembers("agentbase2", edges: overviewEdges)
        precondition(overviewMembers.contains("main-7") && !overviewMembers.contains("sales-task"), "Project focus includes only the selected project's records")
        let ownership = workspace.projectMembership(nodes:overviewNodes,edges:overviewEdges)
        precondition(ownership["main-7"] == "agentbase2" && ownership["sales-task"] == "salesforce", "Cached project membership keeps ownership scoped")
        let projectColors = workspace.projectColors(nodes:overviewNodes)
        precondition(projectColors.count == 3 && projectColors["agentbase2"] != projectColors["salesforce"], "Project colors are deterministic and distinct")
        let extraProject = GraphNode(id:"another-project",kind:"project",title:"Another project",summary:"",status:"",uri:nil,degree:0)
        let colorsWithAddition = workspace.projectColors(nodes:overviewNodes + [extraProject])
        let colorsReordered = workspace.projectColors(nodes:Array(overviewNodes.reversed()))
        precondition(colorsWithAddition["agentbase2"] == projectColors["agentbase2"] && colorsReordered["agentbase2"] == projectColors["agentbase2"], "Adding projects or changing node order does not recolor existing projects")
        var renamedProjects = overviewNodes
        renamedProjects[0] = GraphNode(id:"agentbase2",kind:"project",title:"Renamed root",summary:"",status:"",uri:nil,degree:1)
        precondition(workspace.projectColors(nodes:renamedProjects)["agentbase2"] == projectColors["agentbase2"], "Renaming a project does not change its color")
        let retained = layout.particles["n0"]!.point; layout.sync(nodes: graphNodes, edges: graphEdges)
        precondition(layout.particles["n0"]!.point == retained, "Live updates preserve graph positions")
        layout.sync(nodes: [graphNodes[0]], edges: []); layout.pinned = nil; layout.gravity = 0.7; layout.repulsion = 0; layout.heat = 1
        let before = hypot(layout.particles["n0"]!.point.x,layout.particles["n0"]!.point.y)
        for _ in 0..<100 { layout.step() }
        precondition(hypot(layout.particles["n0"]!.point.x,layout.particles["n0"]!.point.y) < before, "Gravity pulls toward center")
        let parentPoint = layout.particles["n0"]!.point
        let fresh = GraphNode(id:"new-linked",kind:"concept",title:"New linked concept",summary:"",status:"active",uri:nil,degree:1)
        let freshEdge = GraphEdge(source:"n0",target:fresh.id,relation:"child")
        layout.sync(nodes:[graphNodes[0],fresh],edges:[freshEdge],newIDs:[fresh.id],now:100)
        precondition(layout.particles["n0"]!.point == parentPoint, "A new node must not reset existing positions")
        precondition(abs(hypot(layout.particles[fresh.id]!.point.x-parentPoint.x,layout.particles[fresh.id]!.point.y-parentPoint.y)-100) < 0.001, "New child nodes start at their target distance from the parent")
        precondition(layout.appearance(fresh.id,now:100) == 0)
        precondition(abs(layout.appearance(fresh.id,now:100.4)-0.5) < 0.001)
        precondition(layout.appearance(fresh.id,now:101) == 1)
        layout.heat = 0; let freshPoint = layout.particles[fresh.id]!.point
        layout.sync(nodes:[fresh,graphNodes[0]],edges:[freshEdge],now:100.2)
        precondition(layout.births[fresh.id] == 100, "Refresh must not restart birth animation")
        precondition(layout.particles[fresh.id]!.point == freshPoint && layout.heat == 0, "Record ordering alone does not move or reheat the graph")
        model.paused = false; model.accept(try snapshot()); model.selectedID = "task_a"
        precondition(model.hasActiveWork, "Live updates restore the working indicator")
        precondition(model.kanbanTasks.count == 3)
        precondition(KanbanWorkspace(model:model).columns.map(\.id) == ["queue","active","attention","done"], "All is the default board view and includes Done")
        precondition(KanbanColumn.placement(for:model.kanbanTasks.first(where:{$0.id == "task_b"})!) == "attention", "An unmet dependency belongs in Needs attention")
        model.boardFilter = "Open"
        precondition(KanbanWorkspace(model:model).columns.map(\.id) == ["queue","active","attention"] && !model.filteredBoardTasks.contains { ["done","cancelled"].contains($0.text("status")) }, "Open filters hide closed tasks")
        model.boardFilter = "Done"
        precondition(KanbanWorkspace(model:model).columns.map(\.id) == ["done"] && model.filteredBoardTasks.allSatisfy { ["done","cancelled"].contains($0.text("status")) }, "Done focuses closed tasks")
        model.boardFilter = "All"
        precondition(model.kanbanTasks.filter{$0.text("status")=="in_progress"}.map(\.id) == ["task_a"])
        model.setViewMode("Kanban"); precondition(model.viewMode == "Kanban" && model.selectedID == nil)
        let boardRestored = Inspector(preferences:preferences,args:[],environment:[:]); precondition(boardRestored.viewMode == "Kanban")
        model.setViewMode("Skills"); precondition(model.viewMode == "Skills" && model.selectedID == nil)
        let skillsRestored = Inspector(preferences:preferences,args:[],environment:[:]); precondition(skillsRestored.viewMode == "Skills")
        let skillRoot=FileManager.default.temporaryDirectory.appendingPathComponent("agentbase-skill-template-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at:skillRoot,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:skillRoot)}
        let skillCatalog=SkillCatalogModel()
        let skillJSON = Data(#"{"records":[{"id":"skill_warning_check","project_id":"project_a","kind":"skill","version":1,"updated_at":"now","body":{"title":"Research","description":"Find sources","source":"/skills/research/SKILL.md"}}]}"#.utf8)
        let nodeWarning = Data("(node:1234) ExperimentalWarning: SQLite is an experimental feature.\n".utf8)
        let cleanSkillResponse = try skillCommandOutput(stdout:skillJSON,stderr:nodeWarning,terminationStatus:0)
        let decodedSkillIDs = try decodeSkillCatalog(cleanSkillResponse).map(\.id)
        precondition(decodedSkillIDs == ["skill_warning_check"], "Node stderr diagnostics do not corrupt skill-list JSON")
        do {
            _ = try skillCommandOutput(stdout:Data(),stderr:Data("{\"error\":\"Missing project\"}".utf8),terminationStatus:1)
            preconditionFailure("A failed skill command must preserve its diagnostic")
        } catch {
            precondition(error.localizedDescription.contains("Missing project"), "Skill command errors remain visible")
        }
        func skillEntry(_ id:String, _ title:String, _ category:String?) throws -> Entry {
            var body:[String:Any] = ["title":title,"description":"Project skill","status":"active"]
            if let category { body["category"] = category }
            return try JSONDecoder().decode(Entry.self,from:JSONSerialization.data(withJSONObject:["id":id,"project_id":"project_a","kind":"skill","version":1,"updated_at":"now","body":body]))
        }
        skillCatalog.skills = [try skillEntry("coding","Review code","Coding"),try skillEntry("general","Write notes",nil)]
        precondition(skillCatalog.categories == ["All","Coding","General"], "Category choices come from project skills")
        skillCatalog.selectedID = "general"
        skillCatalog.selectedCategory = "Coding"; skillCatalog.selectVisibleSkill()
        precondition(skillCatalog.filtered.map(\.id) == ["coding"] && skillCatalog.selectedID == "coding", "Category filtering keeps the detail selection visible")
        skillCatalog.search = "missing"; skillCatalog.selectVisibleSkill()
        precondition(skillCatalog.filtered.isEmpty && skillCatalog.selectedID == nil, "Search and category filters combine")
        skillCatalog.search = ""; skillCatalog.selectedCategory = "General"; skillCatalog.selectVisibleSkill()
        precondition(skillCatalog.filtered.map(\.id) == ["general"], "Older skills without a category remain in General")
        skillCatalog.load(home:model.home,projectID:Inspector.allProjectsID)
        precondition(skillCatalog.skills.isEmpty && skillCatalog.selectedID == nil, "All Projects clears the project catalog")
        skillCatalog.beginNew(template:SkillTemplate.all.first(where:{$0.id == "review"})!,projectRoot:skillRoot.path)
        precondition(skillCatalog.category == "Coding" && skillCatalog.canSave && skillCatalog.createsFile)
        let firstSkillFile=try skillCatalog.createSkillFile()
        let firstSkillText=try String(contentsOf:firstSkillFile,encoding:.utf8)
        precondition(firstSkillFile.path.hasPrefix(skillRoot.path + "/.agents/skills/") && firstSkillText.contains("name: review-code") && firstSkillText.contains("# Workflow"), "A template creates a usable project-local skill file")
        precondition(skillInstructions(from:firstSkillText).hasPrefix("# Workflow"), "The preview shows instructions without frontmatter")
        precondition(skillInstructions(from:"# Plain skill\n\nDo the work.") == "# Plain skill\n\nDo the work.", "The preview also accepts plain Markdown")
        let secondSkillFile=try skillCatalog.createSkillFile()
        let firstSkillAfterSecond=try String(contentsOf:firstSkillFile,encoding:.utf8)
        precondition(secondSkillFile != firstSkillFile && firstSkillAfterSecond == firstSkillText, "Creating a same-named skill does not overwrite the first one")
        model.setViewMode("Graph"); precondition(model.viewMode == "Graph" && model.snapshot?.records.count == 4)
        model.setViewMode("invalid"); precondition(model.viewMode == "Graph")
        model.resetNavigation(); model.openRecord("task_a"); model.openRecord("task_b"); model.openRecord("plan_a")
        precondition(model.canGoBack && !model.canGoForward)
        model.goBack(); precondition(model.selectedID == "task_b" && model.canGoForward && model.graphFocusID == "task_b")
        model.goForward(); precondition(model.selectedID == "plan_a")
        model.goBack(); model.openRecord("task_c"); precondition(!model.canGoForward && model.history.last == "task_c")
        model.openRecord("task_c"); precondition(model.history.count == 3, "Reopening same record does not duplicate history")
        for i in 0..<70 {model.openRecord("history-\(i)")}; precondition(model.history.count == 50 && model.historyIndex == 49)
        model.resetNavigation(); precondition(model.history.isEmpty && !model.canGoBack && !model.canGoForward)
        model.boardFilter = "Open"; precondition(model.filteredBoardTasks.count == 2)
        model.boardFilter = "Done"; precondition(model.filteredBoardTasks.map(\.id) == ["task_c"])
        model.boardFilter = "Needs attention"; precondition(model.filteredBoardTasks.map(\.id) == ["task_b"])
        model.boardFilter = "All"
        model.boardQuery = "no match"; precondition(model.filteredBoardTasks.isEmpty)
        model.showOnBoard("task_a"); precondition(model.viewMode == "Kanban" && model.boardQuery.isEmpty && model.boardFilter == "All" && model.selectedID == "task_a")
        let focusToken = model.graphFocusRequest; model.showInGraph("task_a")
        precondition(model.viewMode == "Graph" && model.selectedID == "task_a" && model.graphFocusID == "task_a" && model.graphFocusRequest != focusToken)
        model.accept(try snapshot(completedOnly:true)); model.boardFilter = "Open"; model.boardQuery = ""
        precondition(!model.hasActiveWork, "A completed task cannot animate the corner icon")
        precondition(model.filteredBoardTasks.isEmpty && model.boardHasFilters)
        precondition(model.boardEmptyExplanation == "All 3 saved tasks are completed or cancelled.")
        model.clearBoardFilters(); precondition(!model.boardHasFilters && model.filteredBoardTasks.count == 3 && model.boardEmptyExplanation == nil)
        model.boardQuery = "unmatched search"; precondition(model.boardEmptyExplanation == "No tasks match this search.")
        model.clearBoardFilters(); precondition(model.boardQuery.isEmpty && model.boardFilter == "All")
        model.accept(try snapshot(completedOnly:true,totalTasks:200)); model.boardFilter = "Open"
        precondition(model.boardEmptyExplanation == "No open tasks in the loaded records.", "Partial history must not imply every saved task is closed")
        model.boardFilter = "Needs attention"; precondition(model.boardEmptyExplanation == "No loaded tasks need attention.")
        model.clearBoardFilters()
        model.accept(try snapshot(totalTasks:1001)); model.boardQuery = "keep"; model.boardFilter = "Open"
        precondition(model.canLoadMoreTasks && model.taskLimit == 200)
        model.paused = true
        for _ in 0..<8 {model.loadMoreTasks()}
        precondition(model.taskLimit == 1000 && !model.canLoadMoreTasks && model.boardQuery == "keep" && model.boardFilter == "Open")
        model.resetNavigation(); precondition(model.taskLimit == 200)
        let searchNodes = [GraphNode(id:"body",kind:"memory",title:"Other",summary:"query duplicate rows",status:"active",uri:nil,degree:0),GraphNode(id:"title",kind:"memory",title:"Duplicate query",summary:"",status:"active",uri:nil,degree:0),GraphNode(id:"exact",kind:"memory",title:"query duplicate",summary:"",status:"active",uri:nil,degree:0)]
        precondition(graphSearch(searchNodes,query:"  QUERY duplicate ").map(\.id) == ["exact","title","body"])
        precondition(graphSearch(searchNodes,query:"duplicate absent").isEmpty)
        precondition(graphSearch(searchNodes,query:"  ").count == 3)
        let workspaceLaunch = Inspector(preferences:preferences,args:["--root","/different-folder"],environment:[:])
        precondition(workspaceLaunch.projectID == nil,"Explicit launch folder takes precedence over remembered project")
        let envLaunch = Inspector(preferences:preferences,args:[],environment:["AGENTBASE_ROOT":"/different-folder"])
        precondition(envLaunch.projectID == nil)
        model.openRecord("project_a");precondition(model.selectedProjectRoot && model.projectFolder == "/a" && model.projectFolderName == "a")
        let folderNode=GraphNode(id:"project_a",kind:"project",title:"a",summary:"/a",status:"",uri:"/a",degree:1)
        let folderLayout = GraphLayout(); folderLayout.sync(nodes:[folderNode],edges:[])
        precondition(folderLayout.particles[folderNode.id]?.point == .zero,"Folder root starts at graph center")
        let spaceEdges=[GraphEdge(source:"project_a",target:"left",relation:"contains"),GraphEdge(source:"project_a",target:"right",relation:"contains")]
        precondition(!workspace.neighborhood("left",edges:spaceEdges).contains("right"),"Folder membership must not create unrelated local neighbors")
        precondition(workspace.neighborhood("project_a",edges:spaceEdges).contains("right"))
        model.paused = false;model.graphQuery = "current"
        model.accept(try snapshot(searchQuery:"previous"))
        precondition(model.currentSearch == nil && model.searchMessage == "Searching project…","Old response cannot become current search")
        model.accept(try snapshot(searchQuery:"current"))
        precondition(model.currentSearch != nil && model.searchMessage == "No matching project records")
        model.graphQuery = "next";precondition(model.currentSearch == nil)
        model.scheduleGraphSearch();model.graphQuery = "newest";model.scheduleGraphSearch();model.paused = true
        try await Task.sleep(nanoseconds:350_000_000)
        precondition(model.failure == nil,"Debounced search respects pause")
        model.chooseSearchResult(folderNode)
        precondition(model.graphQuery.isEmpty && model.graphFocusPreservesZoom && model.graphFocusID == "project_a" && model.selectedID == "project_a")
        model.resetNavigation();precondition(model.graphQuery.isEmpty && model.graphFocusID == nil)
        workspaceLaunch.stop();envLaunch.stop()
        let setup=ConnectionsModel()
        setup.setWorkspace("/a")
        func connectionReply(_ data:[String:Any]) throws -> ConnectionReply {try JSONDecoder().decode(ConnectionReply.self,from:JSONSerialization.data(withJSONObject:data))}
        setup.apply(try connectionReply(["ok":true,"codex_available":true,"installed":false,"enabled":false,"install_available":true]),host:"codex")
        precondition(ConnectionsButton(model:setup).status == "Not installed")
        setup.apply(try connectionReply(["ok":true,"codex_available":true,"installed":true,"enabled":true,"version":"test-version","reconnect_required":true]),host:"codex")
        precondition(ConnectionsButton(model:setup).status == "Enabled in settings · test-version")
        setup.apply(try connectionReply(["ok":true,"codex_available":true,"installed":true,"enabled":true,"version":"test-version","codex_tool_count":32]),host:"codex")
        precondition(ConnectionsButton(model:setup).status == "Tools verified · test-version")
        setup.setWorkspace("/b")
        precondition(setup.state == nil && setup.workspaceRoot == "/b", "Changing projects clears stale verification")
        setup.apply(try connectionReply(["ok":true,"codex_available":true,"installed":true,"enabled":true,"version":"test-version","codex_tool_count":32]),host:"codex")
        setup.apply(try connectionReply(["ok":false,"error":"Synthetic setup failure"]),host:"codex")
        precondition(setup.state?.enabled == true && setup.error == "Synthetic setup failure","Failure retains last confirmed state")
        setup.apply(try connectionReply(["ok":true,"codex_available":true,"installed":true,"enabled":false]),host:"codex")
        precondition(ConnectionsButton(model:setup).status == "Disabled" && setup.error == nil)
        setup.apply(try connectionReply(["ok":true,"codex_available":false,"installed":false]),host:"codex")
        precondition(ConnectionsButton(model:setup).status == "Codex CLI not found")
        setup.run("unsupported");precondition(!setup.busy)
        let codexHome=FileManager.default.temporaryDirectory.appendingPathComponent("agentbase-codex-discovery-\(UUID().uuidString)")
        defer {try? FileManager.default.removeItem(at:codexHome)}
        #if arch(arm64)
        let platform="macos-aarch64"
        #else
        let platform="macos-x86_64"
        #endif
        let bundledCodex=codexHome.appendingPathComponent(".vscode/extensions/openai.chatgpt-test/bin/\(platform)/codex")
        try FileManager.default.createDirectory(at:bundledCodex.deletingLastPathComponent(),withIntermediateDirectories:true)
        try Data().write(to:bundledCodex)
        try FileManager.default.setAttributes([.posixPermissions:0o755],ofItemAtPath:bundledCodex.path)
        precondition(codexExecutable("codex",searchPath:"/nonexistent",home:codexHome.path)==bundledCodex.path)
        precondition(codexExecutable("/custom/codex",searchPath:"/nonexistent",home:codexHome.path)=="/custom/codex")
        func analysisEntry(_ rows:[[Any]],type:String="DECIMAL(18,2)") throws -> Entry {
            let value:[String:Any] = ["id":"analysis_test","project_id":"project_a","kind":"analysis","version":1,"updated_at":"now","body":["title":"Synthetic chart check","columns":[["name":"month","type":"DATE"],["name":"value","type":type]],"rows":rows,"truncated":true,"inspector_rows_omitted":5]]
            return try JSONDecoder().decode(Entry.self,from:JSONSerialization.data(withJSONObject:value))
        }
        let chartData=AnalysisData(try analysisEntry([["2026-01-01","12.50"],["2026-02-01",-2.0],["2026-03-01",NSNull()],["invalid-date",3.0]]))
        precondition(chartData.numericColumns.map(\.name) == ["value"] && chartData.defaultX(y:1)==0)
        let plotted=chartData.points(x:0,y:1)
        precondition(plotted.count==2 && plotted[0].y==12.5 && plotted[1].y == -2 && plotted[0].date != nil)
        precondition(chartData.omitted==5 && chartData.truncated && AnalysisData.text(chartData.rows[0][1])=="12.50")
        precondition(AnalysisData.number("9007199254740993",type:"BIGINT")==nil,"Unsafe integer magnitudes stay in the table rather than silently rounding")
        precondition(AnalysisData.number("9007199254740991",type:"BIGINT") != nil)
        precondition(AnalysisData.number(true,type:"BOOLEAN")==nil && AnalysisData.number(Double.infinity,type:"DOUBLE")==nil)
        precondition(AnalysisData.date("2026-01-01 12:30:00") != nil)
        precondition(chartData.points(x:-1,y:1).count==3,"Row axis does not require dates")
        let placed=DetailPanelPlacement.clamped(CGPoint(x:2000,y:-100),size:CGSize(width:560,height:650),container:CGSize(width:1200,height:800))
        precondition(placed==CGPoint(x:628,y:34))
        let resized=DetailPanelPlacement.clamped(CGPoint(x:800,y:700),size:CGSize(width:560,height:500),container:CGSize(width:880,height:600))
        precondition(resized==CGPoint(x:308,y:82),"Resizing keeps the panel header reachable")
        model.stop()
        print("Native model and graph physics checks passed: task filters, navigation, project pinning, remembered store, retained snapshots, reconnect scheduling and pause cancellation.")
    }
}
