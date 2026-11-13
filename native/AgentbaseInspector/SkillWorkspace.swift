import SwiftUI

private struct SkillCatalog: Decodable { let records: [Entry] }

@MainActor
final class SkillCatalogModel: ObservableObject {
    @Published var skills: [Entry] = []
    @Published var selectedID: String?
    @Published var search = ""
    @Published var editing = false
    @Published var busy = false
    @Published var message: String?
    @Published var error: String?
    @Published var title = ""
    @Published var description = ""
    @Published var triggers = ""
    @Published var tags = ""
    @Published var appliesTo = ""
    @Published var source = ""
    @Published var status = "active"
    private var editingID: String?
    private var editingVersion: Int?
    private let bundled: [(slug: String, title: String, description: String, triggers: [String], tags: [String], applies: [String])] = [
        ("agentbase-resume", "Continue project work", "Resume work using project memory, plans, tasks, decisions, and handoffs.", ["continue project", "resume work", "switch workspace"], ["continuity", "handoff", "tasks", "planning"], ["project work", "coding", "planning"]),
        ("agentbase-analyse", "Analyze local data", "Import and analyze CSV, JSON, JSONL, or Parquet project data with Agentbase.", ["analyze data", "import csv", "inspect dataset"], ["csv", "json", "jsonl", "parquet", "analysis"], ["data analysis", "project data"]),
        ("agentbase-recover", "Back up and restore Agentbase", "Back up, verify, or restore Agentbase project state.", ["back up project", "restore project", "recover state"], ["backup", "restore", "recovery"], ["project recovery", "data safety"])
    ]

    var selected: Entry? { skills.first { $0.id == selectedID } }
    var filtered: [Entry] {
        guard !search.isEmpty else { return skills }
        return skills.filter { skill in
            let fields = [skill.title, skill.text("description"), skill.text("source")] + strings(skill, "triggers") + strings(skill, "tags") + strings(skill, "applies_to")
            return fields.contains { $0.localizedCaseInsensitiveContains(search) }
        }
    }

    func load(home: String, projectID: String?) {
        guard let projectID, projectID != Inspector.allProjectsID else { skills = []; selectedID = nil; message = "Choose a project to manage skills."; return }
        guard !busy else { return }
        busy = true; error = nil; message = nil
        Task {
            do {
                let listed = try await call("skill_list", projectID: projectID, home: home, fields: ["status":"all", "limit":100, "offset":0])
                var records = try JSONDecoder().decode(SkillCatalog.self, from: listed).records
                var added = 0
                let runtime = try runtimeConfig()
                for item in bundled {
                    let ref = "\(runtime.source)/skills/\(item.slug)/SKILL.md"
                    guard !records.contains(where: { $0.text("source").hasSuffix("/skills/\(item.slug)/SKILL.md") }) else { continue }
                    let data = try await call("skill_save", projectID: projectID, home: home, fields: [
                        "title":item.title, "description":item.description, "triggers":item.triggers, "tags":item.tags,
                        "applies_to":item.applies, "source":ref, "status":"active"
                    ])
                    records.append(try JSONDecoder().decode(Entry.self, from: data)); added += 1
                }
                skills = records.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
                if selectedID == nil || !skills.contains(where: { $0.id == selectedID }) { selectedID = skills.first?.id }
                if added > 0 { message = "Added \(added) bundled skills." }
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    func beginNew(sourceRoot: String) {
        editingID = nil; editingVersion = nil; title = ""; description = ""; triggers = ""; tags = ""; appliesTo = ""; source = "\(sourceRoot)/skills/"; status = "active"; editing = true; error = nil
    }
    func beginEdit(_ skill: Entry) {
        editingID = skill.id; editingVersion = skill.version; title = skill.title; description = skill.text("description")
        triggers = strings(skill,"triggers").joined(separator: "\n"); tags = strings(skill,"tags").joined(separator: "\n")
        appliesTo = strings(skill,"applies_to").joined(separator: "\n"); source = skill.text("source"); status = skill.text("status"); editing = true; error = nil
    }
    func cancelEdit() { editing = false; error = nil }
    func sourceRoot() -> String { (try? runtimeConfig().source) ?? "" }
    func save(home: String, projectID: String?) {
        guard let projectID, !busy else { return }
        busy = true; error = nil
        var fields: [String: Any] = ["title":title, "description":description, "triggers":lines(triggers), "tags":lines(tags), "applies_to":lines(appliesTo), "source":source, "status":status]
        if let editingID, let editingVersion { fields["id"] = editingID; fields["expected_version"] = editingVersion }
        Task {
            do {
                let data = try await call("skill_save", projectID: projectID, home: home, fields: fields)
                let saved = try JSONDecoder().decode(Entry.self, from: data)
                if let i = skills.firstIndex(where: { $0.id == saved.id }) { skills[i] = saved } else { skills.append(saved) }
                skills.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }; selectedID = saved.id; editing = false; message = "Skill saved."
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    private func strings(_ entry: Entry, _ key: String) -> [String] { entry.body[key]?.raw as? [String] ?? [] }
    private func lines(_ value: String) -> [String] { value.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    private func runtimeConfig() throws -> (node: String, source: String) {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("runtime.json"), let data = try? Data(contentsOf: url),
              let config = try JSONSerialization.jsonObject(with: data) as? [String:String], let node = config["node"], let source = config["source"] else { throw NSError(domain:"Skills", code:1, userInfo:[NSLocalizedDescriptionKey:"Runtime configuration is missing. Rebuild with npm run ui:build."]) }
        return (node, source)
    }
    func call(_ tool: String, projectID: String, home: String, fields: [String:Any]) async throws -> Data {
        let runtime = try runtimeConfig()
        var params: [String:Any] = ["project_id":projectID]
        if tool == "skill_save" { params["actor"] = "inspector"; params["request_id"] = UUID().uuidString }
        fields.forEach { params[$0.key] = $0.value }
        let input = try JSONSerialization.data(withJSONObject: params)
        return try await Task.detached {
            guard let payload = String(data:input,encoding:.utf8) else { throw NSError(domain:"Skills",code:2,userInfo:[NSLocalizedDescriptionKey:"Could not encode the skill request."]) }
            let process = Process()
            let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("agentbase-skill-\(UUID().uuidString).log")
            FileManager.default.createFile(atPath:outputURL.path,contents:nil)
            defer { try? FileManager.default.removeItem(at:outputURL) }
            let outputFile = try FileHandle(forUpdating:outputURL)
            process.executableURL = URL(fileURLWithPath:"/bin/zsh")
            process.arguments = ["-c", "cd /tmp && exec \"$1\" \"$2\" call \"$3\" \"$4\" --home \"$5\"", "agentbase-skill", runtime.node, "\(runtime.source)/bin/agentbase.mjs", tool, payload, home]
            process.environment = ["HOME":NSHomeDirectory(),"PATH":"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin","LANG":"C.UTF-8","TMPDIR":FileManager.default.temporaryDirectory.path,"PWD":"/tmp"]
            process.standardOutput = outputFile; process.standardError = outputFile
            try process.run(); process.waitUntilExit(); outputFile.synchronizeFile(); try outputFile.seek(toOffset:0)
            let output = outputFile.readDataToEndOfFile(); try outputFile.close()
            guard process.terminationStatus == 0 else { throw NSError(domain:"Skills", code:Int(process.terminationStatus), userInfo:[NSLocalizedDescriptionKey:String(data:output,encoding:.utf8) ?? "Skill operation failed."]) }
            return output
        }.value
    }
}

struct TaskSkillRecommendations: View {
    @ObservedObject var model: Inspector
    let task: Entry
    private var current: Bool { model.snapshot?.focused_record_id == task.id }
    private var recommendations: [SkillRecommendation] { current ? model.snapshot?.skill_recommendations ?? [] : [] }
    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            HStack {
                Text("Suggested skills").font(.headline)
                Spacer()
                Button { model.start() } label: { Image(systemName:"arrow.clockwise") }.buttonStyle(.plain).help("Refresh suggestions")
            }
            Text("Matched from this task’s text. A suggestion doesn’t load the skill file.").font(.caption).foregroundStyle(.secondary)
            if !current { Text(model.failure.map { "Recommendations unavailable · \($0)" } ?? "Finding project skills…").font(.caption).foregroundStyle(model.failure == nil ? Color.secondary : Color.orange) }
            else if recommendations.isEmpty { Text("No matching active skills yet.").font(.caption).foregroundStyle(.secondary) }
            else {
                ForEach(recommendations) { skill in
                    VStack(alignment:.leading,spacing:7) {
                        Text(skill.title).font(.subheadline.weight(.semibold))
                        Text(skill.description).font(.caption).foregroundStyle(.secondary)
                        ForEach(skill.reasons,id:\.self) { reason in Text("• " + reason).font(.caption).foregroundStyle(.secondary) }
                        Text(skill.source).font(.system(.caption2,design:.monospaced)).foregroundStyle(.tertiary).textSelection(.enabled).lineLimit(2)
                    }.frame(maxWidth:.infinity,alignment:.leading).padding(12).background(.white.opacity(0.045),in:RoundedRectangle(cornerRadius:9))
                }
            }
        }
    }
}

struct SkillWorkspace: View {
    @ObservedObject var model: Inspector
    @StateObject private var catalog = SkillCatalogModel()
    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:12) {
                Picker("Project",selection:Binding(get:{model.projectID ?? model.snapshot?.selected_project_id ?? ""},set:{model.selectProject($0)})) {
                    Text("All Projects").tag(Inspector.allProjectsID)
                    ForEach(model.projects) { Text($0.displayName).tag($0.id) }
                }.labelsHidden().frame(maxWidth:180)
                WorkspaceViewToggle(model:model)
                Spacer()
                Button { catalog.load(home:model.home,projectID:model.projectID) } label: { Image(systemName:"arrow.clockwise") }.help("Refresh skills")
                Button { catalog.beginNew(sourceRoot: catalog.sourceRoot()) } label: { Label("New skill",systemImage:"plus") }.buttonStyle(.borderedProminent).disabled(model.isAllProjects || catalog.busy)
            }.padding(.horizontal,20).padding(.top,34).padding(.bottom,16)
            Divider()
            if catalog.editing { editor }
            else { browse }
        }
        .onAppear { catalog.load(home:model.home,projectID:model.projectID) }
        .onChange(of:model.projectID) { _,_ in catalog.selectedID=nil; catalog.load(home:model.home,projectID:model.projectID) }
        .onChange(of:model.home) { _,_ in catalog.skills=[]; catalog.load(home:model.home,projectID:model.projectID) }
        .background(Color(red:0.045,green:0.055,blue:0.065))
    }
    private var browse: some View {
        VStack(spacing:0) {
            if let error=catalog.error { Label(error,systemImage:"exclamationmark.triangle").font(.caption).foregroundStyle(.orange).frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,20).padding(.vertical,8) }
            HStack(spacing:0) {
            VStack(spacing:12) {
                TextField("Find a skill",text:$catalog.search).textFieldStyle(.roundedBorder)
                if catalog.filtered.isEmpty {
                    ContentUnavailableView(catalog.skills.isEmpty ? "No skills yet" : "No matches", systemImage:"sparkles", description:Text(catalog.skills.isEmpty ? "Bundled project skills will appear here." : "Try a different search."))
                } else {
                    List(selection:$catalog.selectedID) {
                        ForEach(catalog.filtered) { skill in
                            VStack(alignment:.leading,spacing:4) {
                                Text(skill.title).font(.headline).lineLimit(1)
                                Text(skill.text("description")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                HStack { StatusBadge(value:skill.text("status")); Text("\(catalog.listCount(skill))").font(.caption2).foregroundStyle(.tertiary) }
                            }.padding(.vertical,5).tag(skill.id)
                        }
                    }.listStyle(.sidebar)
                }
            }.padding(16).frame(width:310)
            Divider()
            Group {
                if let skill=catalog.selected { detail(skill) }
                else { ContentUnavailableView("Select a skill",systemImage:"sparkles",description:Text("Browse the project catalog or add a skill.")) }
            }.frame(maxWidth:.infinity,maxHeight:.infinity)
            }
            Spacer(minLength:0)
            if let message=catalog.message { Text(message).font(.caption).foregroundStyle(.secondary).padding(12) }
        }
        .overlay(alignment:.bottomLeading) { if catalog.busy { ProgressView().controlSize(.small).padding(12) } }
    }
    private func detail(_ skill: Entry) -> some View {
        ScrollView {
            VStack(alignment:.leading,spacing:22) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:8) { Text(skill.title).font(.largeTitle.bold()); StatusBadge(value:skill.text("status")) }
                    Spacer(); Button("Edit") { catalog.beginEdit(skill) }.buttonStyle(.bordered)
                }
                Text(skill.text("description")).font(.body).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                chipSection("Use when", values:catalog.values(skill,"triggers"))
                chipSection("Tags", values:catalog.values(skill,"tags"))
                chipSection("Applies to", values:catalog.values(skill,"applies_to"))
                VStack(alignment:.leading,spacing:8) { Text("SOURCE").font(.caption.weight(.semibold)).foregroundStyle(.secondary); Text(skill.text("source")).font(.callout.monospaced()).textSelection(.enabled) }
                if let error=catalog.error { Label(error,systemImage:"exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth:700,alignment:.leading).padding(32).frame(maxWidth:.infinity,alignment:.topLeading)
        }
    }
    private func chipSection(_ title: String, values: [String]) -> some View {
        VStack(alignment:.leading,spacing:9) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if values.isEmpty { Text("None").foregroundStyle(.tertiary) }
            else { FlowChips(values:values) }
        }
    }
    private var editor: some View {
        Form {
            Section("Skill details") {
                TextField("Name",text:$catalog.title)
                TextField("Description",text:$catalog.description,axis:.vertical).lineLimit(2...4)
                Picker("Status",selection:$catalog.status) { Text("Active").tag("active"); Text("Disabled").tag("disabled") }
                TextField("Source reference",text:$catalog.source)
            }
            Section("Matching") {
                TextField("Trigger phrases · one per line",text:$catalog.triggers,axis:.vertical).lineLimit(2...4)
                TextField("Tags · one per line",text:$catalog.tags,axis:.vertical).lineLimit(2...4)
                TextField("Applies to · one per line",text:$catalog.appliesTo,axis:.vertical).lineLimit(2...4)
            }
            if let error=catalog.error { Text(error).foregroundStyle(.orange) }
            HStack { Spacer(); Button("Cancel") { catalog.cancelEdit() }.keyboardShortcut(.cancelAction); Button("Save skill") { catalog.save(home:model.home,projectID:model.projectID) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent).disabled(catalog.title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || catalog.description.isEmpty || catalog.source.isEmpty || catalog.busy) }
        }.formStyle(.grouped).padding(20).frame(maxWidth:760).frame(maxWidth:.infinity,maxHeight:.infinity)
    }
}

private struct FlowChips: View {
    let values: [String]
    var body: some View {
        LazyVGrid(columns:[GridItem(.adaptive(minimum:110),alignment:.leading)],alignment:.leading,spacing:8) {
            ForEach(values,id:\.self) { value in Text(value).font(.caption).padding(.horizontal,10).padding(.vertical,6).background(.white.opacity(0.08),in:Capsule()) }
        }
    }
}

private extension SkillCatalogModel {
    func values(_ entry: Entry,_ key: String) -> [String] { entry.body[key]?.raw as? [String] ?? [] }
    func listCount(_ entry: Entry) -> String { "\(values(entry,"triggers").count) triggers" }
}
