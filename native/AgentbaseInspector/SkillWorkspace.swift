import SwiftUI
import AppKit

private struct SkillCatalog: Decodable { let records: [Entry] }
private struct SkillCatalogPage: Decodable {
    let records: [Entry]
    let total: Int
}

func decodeSkillCatalog(_ data: Data) throws -> [Entry] {
    try JSONDecoder().decode(SkillCatalog.self, from:data).records
}

func skillCommandOutput(stdout: Data, stderr: Data, terminationStatus: Int32) throws -> Data {
    guard terminationStatus == 0 else {
        let diagnostic = stderr.isEmpty ? stdout : stderr
        let message = String(data:diagnostic,encoding:.utf8)?.trimmingCharacters(in:.whitespacesAndNewlines)
        throw NSError(domain:"Skills",code:Int(terminationStatus),userInfo:[NSLocalizedDescriptionKey:message?.isEmpty == false ? message! : "Skill operation failed."])
    }
    guard !stdout.isEmpty else {
        throw NSError(domain:"Skills",code:4,userInfo:[NSLocalizedDescriptionKey:"Skill command returned no JSON data."])
    }
    return stdout
}

func skillInstructions(from content: String) -> String {
    let lines = content.components(separatedBy:.newlines)
    if lines.first?.trimmingCharacters(in:.whitespaces) == "---",
       let end = lines.dropFirst().firstIndex(where:{$0.trimmingCharacters(in:.whitespaces) == "---"}) {
        return lines.dropFirst(end+1).joined(separator:"\n").trimmingCharacters(in:.whitespacesAndNewlines)
    }
    return content.trimmingCharacters(in:.whitespacesAndNewlines)
}

struct SkillTemplate: Identifiable {
    let id: String
    let category: String
    let title: String
    let summary: String
    let description: String
    let triggers: [String]
    let tags: [String]
    let appliesTo: [String]
    let instructions: String
    static let categories = ["General", "Coding", "Research", "Data", "Planning", "Writing"]
    static let all: [SkillTemplate] = [
        .init(id:"blank",category:"General",title:"Blank skill",summary:"Start with a clean outline.",description:"Describe when this skill should be used and what it helps accomplish.",triggers:[],tags:[],appliesTo:[],instructions:"# Instructions\n\nDescribe the steps the agent should follow. Include the inputs it needs and the result it should produce."),
        .init(id:"implement",category:"Coding",title:"Implement a change",summary:"Guide changes from context through verification.",description:"Implement a focused project change and verify the result.",triggers:["implement a change","fix an issue"],tags:["implementation","testing"],appliesTo:["code changes"],instructions:"# Workflow\n\n1. Read the relevant code and project instructions.\n2. Make the smallest complete change.\n3. Run checks that cover the changed behavior.\n4. Report what changed, what passed, and any remaining limitation."),
        .init(id:"review",category:"Coding",title:"Review code",summary:"Check behavior, regressions, and missing coverage.",description:"Review a code change for defects and practical risks.",triggers:["review code","review a change"],tags:["review","quality"],appliesTo:["pull requests","code changes"],instructions:"# Workflow\n\n1. Read the change and its surrounding code.\n2. Check for incorrect behavior, regressions, and missing validation.\n3. Report concrete findings with file locations and impact.\n4. State any areas you could not verify."),
        .init(id:"research",category:"Research",title:"Research a question",summary:"Collect sources and produce a concise answer.",description:"Investigate a project question using relevant sources and explain the conclusion.",triggers:["research a question","investigate a topic"],tags:["research","sources"],appliesTo:["project research"],instructions:"# Workflow\n\n1. Define the question and the evidence needed.\n2. Check primary sources and record where each key fact came from.\n3. Compare conflicting evidence and distinguish facts from inference.\n4. Summarize the answer with source links and remaining uncertainty."),
        .init(id:"analyse",category:"Data",title:"Analyze data",summary:"Inspect a dataset and explain useful findings.",description:"Analyze project data and present reproducible findings.",triggers:["analyze data","inspect a dataset"],tags:["data","analysis"],appliesTo:["datasets","reports"],instructions:"# Workflow\n\n1. Confirm the dataset, fields, and question.\n2. Check missing values, types, and unusual records.\n3. Run the analysis and retain the calculations needed to reproduce it.\n4. Explain the findings, assumptions, and limitations."),
        .init(id:"plan",category:"Planning",title:"Plan project work",summary:"Turn a goal into clear steps and checks.",description:"Create a practical plan for a project goal.",triggers:["plan project work","break down a goal"],tags:["planning","tasks"],appliesTo:["project planning"],instructions:"# Workflow\n\n1. Clarify the outcome, constraints, and current state.\n2. Break the work into ordered, testable steps.\n3. Identify dependencies and decisions that need user input.\n4. Define how completion will be checked."),
        .init(id:"write",category:"Writing",title:"Draft content",summary:"Write and revise content for a specific audience.",description:"Draft clear content that fits its audience and purpose.",triggers:["draft content","write a document"],tags:["writing","editing"],appliesTo:["documents","communications"],instructions:"# Workflow\n\n1. Identify the audience, purpose, and required format.\n2. Gather the facts and examples the draft needs.\n3. Write a direct first draft with a clear structure.\n4. Check accuracy, tone, and length before delivery.")
    ]
}

@MainActor
final class SkillCatalogModel: ObservableObject {
    @Published var skills: [Entry] = []
    @Published var selectedID: String?
    @Published var search = ""
    @Published var selectedCategory = "All"
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
    @Published var category = "General"
    @Published var instructions = ""
    @Published var status = "active"
    private var editingID: String?
    private var editingVersion: Int?
    private var templateRoot: String?
    private var loadRevision = 0
    private var loading = false
    private var loadedScope: String?
    private let bundled: [(slug: String, title: String, description: String, triggers: [String], tags: [String], applies: [String])] = [
        ("agentbase-resume", "Continue project work", "Track and resume substantive project work, including research, reviews, audits, investigations, and coding, using project memory, tasks, and handoffs.", ["continue project", "resume work", "switch workspace", "review a project", "research a project", "audit a project", "investigate a project"], ["continuity", "handoff", "tasks", "planning", "review", "research", "audit", "investigation"], ["project work", "coding", "planning", "research", "reviews", "audits", "investigations"]),
        ("agentbase-analyse", "Analyze local data", "Import and analyze CSV, JSON, JSONL, or Parquet project data with Agentbase.", ["analyze data", "import csv", "inspect dataset"], ["csv", "json", "jsonl", "parquet", "analysis"], ["data analysis", "project data"]),
        ("agentbase-recover", "Back up and restore Agentbase", "Back up, verify, or restore Agentbase project state.", ["back up project", "restore project", "recover state"], ["backup", "restore", "recovery"], ["project recovery", "data safety"])
    ]

    var selected: Entry? { skills.first { $0.id == selectedID } }
    var categories: [String] {
        let values = Set(skills.map { $0.text("category").isEmpty ? "General" : $0.text("category") })
        return ["All"] + values.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
    var editorCategories: [String] {
        Array(Set(SkillTemplate.categories + categories.filter {$0 != "All"})).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
    var filtered: [Entry] {
        return skills.filter { skill in
            let category = skill.text("category").isEmpty ? "General" : skill.text("category")
            guard selectedCategory == "All" || category == selectedCategory else { return false }
            guard !search.isEmpty else { return true }
            let fields = [skill.title, skill.text("description"), skill.text("source"), skill.text("category")] + strings(skill, "triggers") + strings(skill, "tags") + strings(skill, "applies_to")
            return fields.contains { $0.localizedCaseInsensitiveContains(search) }
        }
    }
    func selectVisibleSkill() {
        if !filtered.contains(where: { $0.id == selectedID }) { selectedID = filtered.first?.id }
    }

    func load(home: String, projectID: String?) {
        guard !busy || loading else { return }
        loadRevision += 1
        let revision = loadRevision
        let scope = home + "|" + (projectID ?? "")
        if loadedScope != scope { skills = []; selectedID = nil; selectedCategory = "All"; loadedScope = scope }
        error = nil; message = nil
        guard let projectID, projectID != Inspector.allProjectsID else { loading = false; busy = false; return }
        loading = true; busy = true
        Task {
            do {
                var records: [Entry] = []
                var offset = 0
                var total = Int.max
                while offset < total {
                    let listed = try await call("skill_list", projectID: projectID, home: home, fields: ["status":"all", "limit":100, "offset":offset])
                    guard revision == loadRevision else { return }
                    let page = try JSONDecoder().decode(SkillCatalogPage.self, from: listed)
                    total = page.total
                    records.append(contentsOf: page.records)
                    guard !page.records.isEmpty else { break }
                    offset += page.records.count
                }
                var added = 0
                let runtime = try runtimeConfig()
                for item in bundled {
                    guard revision == loadRevision else { return }
                    let ref = "\(runtime.source)/skills/\(item.slug)/SKILL.md"
                    guard !records.contains(where: { $0.text("source").hasSuffix("/skills/\(item.slug)/SKILL.md") }) else { continue }
                    let data = try await call("skill_save", projectID: projectID, home: home, fields: [
                        "title":item.title, "description":item.description, "triggers":item.triggers, "tags":item.tags,
                        "applies_to":item.applies, "source":ref, "category":item.slug == "agentbase-analyse" ? "Data" : "General", "status":"active"
                    ])
                    guard revision == loadRevision else { return }
                    records.append(try JSONDecoder().decode(Entry.self, from: data)); added += 1
                }
                guard revision == loadRevision else { return }
                skills = records.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
                if !categories.contains(selectedCategory) { selectedCategory = "All" }
                selectVisibleSkill()
                if added > 0 { message = "Added \(added) bundled skills." }
            } catch { if revision == loadRevision { self.error = error.localizedDescription } }
            if revision == loadRevision { loading = false; busy = false }
        }
    }

    func beginNew(template: SkillTemplate, projectRoot: String) {
        editingID = nil; editingVersion = nil; templateRoot = projectRoot
        title = template.id == "blank" ? "" : template.title
        description = template.id == "blank" ? "" : template.description
        triggers = template.triggers.joined(separator:"\n"); tags = template.tags.joined(separator:"\n")
        appliesTo = template.appliesTo.joined(separator:"\n"); instructions = template.instructions
        source = ""; category = template.category; status = "active"; editing = true; error = nil
    }
    func beginEdit(_ skill: Entry) {
        templateRoot = nil; editingID = skill.id; editingVersion = skill.version; title = skill.title; description = skill.text("description")
        triggers = strings(skill,"triggers").joined(separator: "\n"); tags = strings(skill,"tags").joined(separator: "\n")
        appliesTo = strings(skill,"applies_to").joined(separator: "\n"); source = skill.text("source"); category = skill.text("category").isEmpty ? "General" : skill.text("category"); status = skill.text("status"); editing = true; error = nil
    }
    func cancelEdit() { editing = false; error = nil }
    var createsFile: Bool { editingID == nil && templateRoot != nil }
    var canSave: Bool {
        !busy && !title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && !description.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty &&
        (createsFile ? !instructions.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty : !source.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
    }
    func save(home: String, projectID: String?) {
        guard let projectID, canSave else { return }
        busy = true; error = nil
        var fields: [String: Any] = ["title":title, "description":description, "triggers":lines(triggers), "tags":lines(tags), "applies_to":lines(appliesTo), "source":source, "status":status]
        fields["category"] = category
        if let editingID, let editingVersion { fields["id"] = editingID; fields["expected_version"] = editingVersion }
        Task {
            var createdFile: URL?
            do {
                if createsFile {
                    createdFile = try createSkillFile()
                    fields["source"] = createdFile!.path
                }
                let data = try await call("skill_save", projectID: projectID, home: home, fields: fields)
                let didCreateFile = createdFile != nil
                createdFile = nil
                let saved = try JSONDecoder().decode(Entry.self, from: data)
                if let i = skills.firstIndex(where: { $0.id == saved.id }) { skills[i] = saved } else { skills.append(saved) }
                skills.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }; selectedID = saved.id; editing = false; templateRoot = nil; message = didCreateFile ? "Skill created in this project." : "Skill saved."
            } catch {
                if let createdFile { try? FileManager.default.removeItem(at:createdFile.deletingLastPathComponent()) }
                self.error = error.localizedDescription
            }
            busy = false
        }
    }

    func createSkillFile() throws -> URL {
        guard let templateRoot, FileManager.default.fileExists(atPath:templateRoot) else {
            throw NSError(domain:"Skills",code:3,userInfo:[NSLocalizedDescriptionKey:"The project folder is unavailable."])
        }
        let folder=URL(fileURLWithPath:templateRoot,isDirectory:true).appendingPathComponent(".agents/skills",isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        let folded=title.folding(options:[.diacriticInsensitive,.widthInsensitive],locale:.current).lowercased()
        let slug=folded.split(whereSeparator:{ !$0.isASCII || !$0.isLetter && !$0.isNumber }).joined(separator:"-")
        let base=slug.isEmpty ? "custom-skill" : slug
        var name=base, number=2
        while FileManager.default.fileExists(atPath:folder.appendingPathComponent(name).path) { name="\(base)-\(number)"; number += 1 }
        let directory=folder.appendingPathComponent(name,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false)
        let file=directory.appendingPathComponent("SKILL.md")
        let summary=description.split(whereSeparator:\.isNewline).joined(separator:" ").trimmingCharacters(in:.whitespacesAndNewlines)
        let content="---\nname: \(name)\ndescription: >-\n  \(summary)\n---\n\n\(instructions.trimmingCharacters(in:.whitespacesAndNewlines))\n"
        do { try content.write(to:file,atomically:true,encoding:.utf8) }
        catch { try? FileManager.default.removeItem(at:directory); throw error }
        return file
    }

    private func strings(_ entry: Entry, _ key: String) -> [String] { entry.body[key]?.raw as? [String] ?? [] }
    private func lines(_ value: String) -> [String] { value.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    private func runtimeConfig() throws -> (node: String, source: String) {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("runtime.json"), let data = try? Data(contentsOf: url),
              let config = try JSONSerialization.jsonObject(with: data) as? [String:String], let node = config["node"], let source = config["source"] else { throw NSError(domain:"Skills", code:1, userInfo:[NSLocalizedDescriptionKey:"Runtime configuration is missing. Rebuild with npm run ui:build."]) }
        return (bundledPath(node), bundledPath(source))
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
            let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("agentbase-skill-\(UUID().uuidString).out")
            let errorURL = FileManager.default.temporaryDirectory.appendingPathComponent("agentbase-skill-\(UUID().uuidString).err")
            FileManager.default.createFile(atPath:outputURL.path,contents:nil)
            FileManager.default.createFile(atPath:errorURL.path,contents:nil)
            defer { try? FileManager.default.removeItem(at:outputURL); try? FileManager.default.removeItem(at:errorURL) }
            let outputFile = try FileHandle(forWritingTo:outputURL)
            let errorFile = try FileHandle(forWritingTo:errorURL)
            process.executableURL = URL(fileURLWithPath:"/bin/zsh")
            process.arguments = ["-c", "cd /tmp && exec \"$1\" \"$2\" call \"$3\" \"$4\" --home \"$5\"", "agentbase-skill", runtime.node, "\(runtime.source)/bin/agentbase.mjs", tool, payload, home]
            process.environment = ["HOME":NSHomeDirectory(),"PATH":"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin","LANG":"C.UTF-8","TMPDIR":FileManager.default.temporaryDirectory.path,"PWD":"/tmp"]
            process.standardOutput = outputFile; process.standardError = errorFile
            try process.run(); process.waitUntilExit()
            outputFile.synchronizeFile(); errorFile.synchronizeFile()
            try outputFile.close(); try errorFile.close()
            let stdout = try Data(contentsOf:outputURL)
            let stderr = try Data(contentsOf:errorURL)
            return try skillCommandOutput(stdout:stdout,stderr:stderr,terminationStatus:process.terminationStatus)
        }.value
    }
}

private struct TaskSourceRow: Identifiable {
    let id: String
    let category: String
    let label: String
    let reference: String
    let note: String?
    let recordID: String?
    let recordKind: String?
    let showsReference: Bool
}

struct TaskSources: View {
    @ObservedObject var model: Inspector
    let task: Entry
    @State private var expanded = false
    private var current: Bool { model.snapshot?.focused_record_id == task.id }
    private var recommendations: [SkillRecommendation] { current ? model.snapshot?.skill_recommendations ?? [] : [] }
    private var rows: [TaskSourceRow] {
        var result: [TaskSourceRow] = []
        let records = model.snapshot?.records ?? []
        let graphNodes = model.snapshot?.graph?.nodes ?? []
        for source in task.body["sources"]?.raw as? [[String:Any]] ?? [] {
            let kind = source["kind"] as? String ?? "reference"
            let reference = source["reference"] as? String ?? ""
            let linked = kind == "record" ? records.first(where:{$0.id == reference}) : nil
            let graphNode = kind == "record" ? graphNodes.first(where:{$0.id == reference}) : nil
            let linkedTitle = linked?.title ?? graphNode?.title
            let linkedKind = linked?.kind ?? graphNode?.kind ?? reference.components(separatedBy:"_").first
            let category = linkedKind == "skill" ? "Skill" : linkedKind?.capitalized ?? kind.capitalized
            let label = source["title"] as? String ?? linkedTitle ?? reference
            result.append(TaskSourceRow(id:"source-\(kind)-\(reference)",category:category,label:label,
                reference:reference,note:source["note"] as? String,recordID:kind == "record" ? reference : nil,recordKind:linkedKind,
                showsReference:kind != "record"))
        }
        for related in model.related(to:task).filter({ !["task","plan","session","checkpoint"].contains($0.kind) }) {
            guard !result.contains(where:{$0.recordID == related.id}) else {continue}
            result.append(TaskSourceRow(id:"record-\(related.id)",category:related.kind.capitalized,label:related.title ?? related.id,
                reference:related.id,note:nil,recordID:related.id,recordKind:related.kind,showsReference:false))
        }
        if let completion = task.body["completion"]?.raw as? [String:Any] {
            for (index,item) in (completion["evidence"] as? [[String:Any]] ?? []).enumerated() {
                let kind = item["kind"] as? String ?? "Evidence"
                let reference = item["reference"] as? String ?? ""
                result.append(TaskSourceRow(id:"evidence-\(index)-\(reference)",category:"Completion · \(kind.capitalized)",label:reference,reference:reference,
                    note:item["outcome"] as? String,recordID:kind == "analysis" ? reference : nil,recordKind:kind == "analysis" ? "analysis" : nil,
                    showsReference:kind != "analysis"))
            }
        }
        for skill in recommendations where !result.contains(where:{$0.recordID == skill.id}) {
            result.append(TaskSourceRow(id:"suggested-\(skill.id)",category:"Suggested skill",label:skill.title,reference:skill.source,
                note:skill.description + (skill.reasons.isEmpty ? "" : " · " + skill.reasons.joined(separator:"; ")),recordID:skill.id,recordKind:"skill",
                showsReference:true))
        }
        return result
    }
    var body: some View {
        DisclosureGroup(isExpanded:$expanded) {
            VStack(alignment:.leading,spacing:10) {
                Text("References, skills, and completion records connected to this task.").font(.system(size:13)).foregroundStyle(.secondary)
                if current {Button("Refresh skill suggestions") {model.start()}.font(.system(size:13)).buttonStyle(.plain).foregroundStyle(accent)}
                if rows.isEmpty && !current { Text(model.failure.map { "Sources unavailable · \($0)" } ?? "Loading task sources…").font(.system(size:13)).foregroundStyle(model.failure == nil ? Color.secondary : Color.orange) }
                else if rows.isEmpty { Text("No sources recorded yet.").font(.system(size:13)).foregroundStyle(.secondary) }
                ForEach(rows) { row in
                    VStack(alignment:.leading,spacing:4) {
                        Text(row.category.uppercased()).font(.system(size:9,weight:.semibold)).tracking(0.7).foregroundStyle(.secondary)
                        if let id = row.recordID { Button(row.label) { model.openRecord(id,kind:row.recordKind) }.buttonStyle(.link).font(.system(size:13,weight:.medium)) }
                        else { Text(row.label).font(.system(size:13,weight:.medium)).textSelection(.enabled) }
                        if row.showsReference && row.reference != row.label {Text(row.reference).font(.system(.caption2,design:.monospaced)).foregroundStyle(.tertiary).textSelection(.enabled).lineLimit(2)}
                        if let note = row.note, !note.isEmpty {MarkdownText(markdown:note,font:.system(size:13)).foregroundStyle(.secondary)}
                    }
                    .frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,8)
                    if row.id != rows.last?.id {Divider().overlay(.white.opacity(0.035))}
                }
            }
        } label: {
            HStack {
                Text("Sources").font(.system(size:13,weight:.semibold))
                Spacer()
                if current {Text("\(rows.count)").font(.system(size:13,design:.rounded).monospacedDigit()).foregroundStyle(.secondary)}
            }
        }
        .onChange(of:task.id) {_,_ in expanded=false}
    }
}

struct SkillWorkspace: View {
    @ObservedObject var model: Inspector
    @StateObject private var catalog = SkillCatalogModel()
    @State private var showingTemplates = false
    @State private var templateCategory = "General"
    private var activeProjectID: String? { model.projectID ?? model.snapshot?.selected_project_id }
    private var needsProject: Bool { activeProjectID == nil || model.isAllProjects }
    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:12) {
                WorkspaceNavigation(model:model,projectDisabled:catalog.editing)
                Spacer()
                Button { catalog.load(home:model.home,projectID:activeProjectID) } label: { Image(systemName:"arrow.clockwise") }.help("Refresh skills").disabled(catalog.busy || needsProject)
                Button { showingTemplates = true } label: { Label("New skill",systemImage:"plus") }
                    .buttonStyle(.borderedProminent).disabled(needsProject || model.currentProject == nil || catalog.busy)
                    .popover(isPresented:$showingTemplates,arrowEdge:.bottom) { templateDialog }
            }.padding(.leading,30).padding(.trailing,20).padding(.top,43).padding(.bottom,16)
            Divider()
            if catalog.editing { editor }
            else { browse }
        }
        .onAppear { catalog.load(home:model.home,projectID:activeProjectID) }
        .onChange(of:activeProjectID) { _,_ in showingTemplates = false; catalog.cancelEdit(); catalog.search = ""; catalog.selectedCategory = "All"; catalog.load(home:model.home,projectID:activeProjectID) }
        .onChange(of:model.home) { _,_ in showingTemplates = false; catalog.cancelEdit(); catalog.search = ""; catalog.selectedCategory = "All"; catalog.load(home:model.home,projectID:activeProjectID) }
        .onChange(of:catalog.search) { _,_ in catalog.selectVisibleSkill() }
        .onChange(of:catalog.selectedCategory) { _,_ in catalog.selectVisibleSkill() }
        .background(Color(red:0.045,green:0.055,blue:0.065))
    }
    private var templateDialog: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text("New skill").font(.title2.bold())
                Spacer()
                Button("Cancel") { showingTemplates = false }.keyboardShortcut(.cancelAction)
            }
            HStack(alignment:.top,spacing:16) {
                VStack(alignment:.leading,spacing:4) {
                    ForEach(SkillTemplate.categories,id:\.self) { category in
                        Button { templateCategory = category } label: {
                            HStack { Text(category); Spacer(); if templateCategory == category { Image(systemName:"checkmark") } }
                                .frame(width:120,alignment:.leading).padding(.horizontal,10).padding(.vertical,8)
                        }.buttonStyle(.plain).background(templateCategory == category ? Color.accentColor.opacity(0.2) : Color.clear,in:RoundedRectangle(cornerRadius:7))
                    }
                }
                Divider()
                ScrollView {
                    VStack(spacing:10) {
                        ForEach(SkillTemplate.all.filter{$0.category == templateCategory}) { template in
                            Button {
                                catalog.beginNew(template:template,projectRoot:model.currentProject?.root ?? "")
                                showingTemplates = false
                            } label: {
                                HStack(alignment:.top,spacing:12) {
                                    Image(systemName:template.id == "blank" ? "doc" : "sparkles").frame(width:20)
                                    VStack(alignment:.leading,spacing:4) {
                                        Text(template.title).font(.headline)
                                        Text(template.summary).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                                    }
                                    Spacer()
                                    Image(systemName:"chevron.right").font(.caption).foregroundStyle(.tertiary)
                                }.padding(14).frame(maxWidth:.infinity,alignment:.leading)
                                    .background(.white.opacity(0.055),in:RoundedRectangle(cornerRadius:9))
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }.frame(height:300)
            Text("Creates a SKILL.md in this project.")
                .font(.caption).foregroundStyle(.secondary)
        }.padding(24).frame(width:610)
    }
    private var browse: some View {
        VStack(spacing:0) {
            if let error=catalog.error { Label(error,systemImage:"exclamationmark.triangle").font(.caption).foregroundStyle(.orange).frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,20).padding(.vertical,8) }
            if needsProject {
                ContentUnavailableView {
                    Label("Choose a project",systemImage:"folder")
                } description: {
                    Text("Skills belong to a project. Select one to browse or create skills.")
                } actions: {
                    if !model.projects.isEmpty {
                        Menu("Select project") {
                            ForEach(model.projects) { project in
                                Button(project.displayName) { model.selectProject(project.id) }
                            }
                        }
                    }
                }
                .frame(maxWidth:.infinity,maxHeight:.infinity)
            } else {
                HStack(spacing:0) {
                    VStack(alignment:.leading,spacing:12) {
                        TextField("Search skills",text:$catalog.search)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Search skills")
                        HStack {
                            Picker("Category",selection:$catalog.selectedCategory) {
                                ForEach(catalog.categories,id:\.self) { category in
                                    Text(category == "All" ? "All categories" : category).tag(category)
                                }
                            }.pickerStyle(.menu)
                            Spacer(minLength:8)
                            Text("\(catalog.filtered.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        if catalog.filtered.isEmpty {
                            Group {
                                if catalog.busy && catalog.skills.isEmpty { ProgressView("Loading skills…") }
                                else { ContentUnavailableView(catalog.skills.isEmpty ? "No skills yet" : "No matches", systemImage:"sparkles", description:Text(catalog.skills.isEmpty ? "Add a skill to this project to get started." : "Try a different search or category.")) }
                            }.frame(maxWidth:.infinity,maxHeight:.infinity)
                        } else {
                            ScrollView {
                                LazyVStack(spacing:6) {
                                    ForEach(catalog.filtered) { skill in
                                        Button { catalog.selectedID = skill.id } label: {
                                            VStack(alignment:.leading,spacing:5) {
                                                HStack(alignment:.firstTextBaseline) {
                                                    Text(skill.title).font(.system(size:14,weight:.semibold)).lineLimit(1)
                                                    Spacer(minLength:4)
                                                    if skill.text("status") == "disabled" { Image(systemName:"pause.circle").foregroundStyle(.secondary) }
                                                }
                                                Text(skill.text("description")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                            }
                                            .frame(maxWidth:.infinity,alignment:.leading)
                                            .padding(.horizontal,12).padding(.vertical,11)
                                            .background(catalog.selectedID == skill.id ? Color.accentColor.opacity(0.19) : Color.white.opacity(0.035),in:RoundedRectangle(cornerRadius:9))
                                            .overlay(RoundedRectangle(cornerRadius:9).stroke(catalog.selectedID == skill.id ? Color.accentColor.opacity(0.42) : Color.clear,lineWidth:1))
                                            .contentShape(RoundedRectangle(cornerRadius:9))
                                        }.buttonStyle(.plain).accessibilityAddTraits(catalog.selectedID == skill.id ? .isSelected : [])
                                    }
                                }.padding(.vertical,2)
                            }
                        }
                    }.padding(18).frame(width:325)
                    .background(Color.white.opacity(0.025))
                    Divider()
                    Group {
                        if let skill=catalog.selected { detail(skill) }
                        else { ContentUnavailableView("Select a skill",systemImage:"sparkles",description:Text("Browse the project catalog or add a skill.")) }
                    }.frame(maxWidth:.infinity,maxHeight:.infinity)
                }
            }
            Spacer(minLength:0)
            if let message=catalog.message { Text(message).font(.caption).foregroundStyle(.secondary).padding(12) }
        }
        .overlay(alignment:.bottomLeading) { if catalog.busy { ProgressView().controlSize(.small).padding(12) } }
    }
    private func detail(_ skill: Entry) -> some View {
        ScrollView {
            VStack(alignment:.leading,spacing:20) {
                HStack(alignment:.top) {
                    VStack(alignment:.leading,spacing:8) {
                        Text(skill.title).font(.title.bold()).textSelection(.enabled)
                        if skill.text("status") == "disabled" { Text("Disabled").font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer(minLength:16)
                    Button("Edit") { catalog.beginEdit(skill) }.buttonStyle(.bordered)
                }
                Text(skill.text("description")).font(.body).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true).textSelection(.enabled)
                let triggers = catalog.values(skill,"triggers")
                if !triggers.isEmpty {
                    VStack(alignment:.leading,spacing:8) {
                        Text("Use when").font(.system(size:13,weight:.semibold)).foregroundStyle(.secondary)
                        ForEach(Array(triggers.enumerated()),id:\.offset) { item in
                            Text(item.element).font(.system(size:13)).textSelection(.enabled)
                        }
                    }
                }
                SkillSourceView(source:skill.text("source")).id(skill.id)
                DisclosureGroup("Details") {
                    VStack(alignment:.leading,spacing:12) {
                        Text("Category: \(skill.text("category").isEmpty ? "General" : skill.text("category"))")
                        let applies = catalog.values(skill,"applies_to")
                        if !applies.isEmpty { Text("Applies to: \(applies.joined(separator:", "))") }
                        let tags = catalog.values(skill,"tags")
                        if !tags.isEmpty { Text("Tags: \(tags.joined(separator:", "))") }
                    }.font(.caption).foregroundStyle(.secondary).padding(.top,8)
                }.font(.system(size:13,weight:.medium))
                if let error=catalog.error { Label(error,systemImage:"exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth:760,alignment:.leading).padding(32).frame(maxWidth:.infinity,alignment:.topLeading)
        }
    }
    private var editor: some View {
        Form {
            Section("Skill details") {
                TextField("Name",text:$catalog.title)
                TextField("Description",text:$catalog.description,axis:.vertical).lineLimit(2...4)
                Picker("Category",selection:$catalog.category) { ForEach(catalog.editorCategories,id:\.self) { Text($0).tag($0) } }
                Picker("Status",selection:$catalog.status) { Text("Active").tag("active"); Text("Disabled").tag("disabled") }
                if catalog.createsFile { Text("A SKILL.md file will be created in this project’s .agents/skills folder.").font(.caption).foregroundStyle(.secondary) }
                else {
                    TextField("Source reference",text:$catalog.source)
                    Text("Edit instructions in the source file.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if catalog.createsFile {
                Section("Instructions") {
                    TextField("What should the agent do?",text:$catalog.instructions,axis:.vertical).lineLimit(10...18)
                    Text("Saved in SKILL.md.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Matching") {
                TextField("Trigger phrases · one per line",text:$catalog.triggers,axis:.vertical).lineLimit(2...4)
                TextField("Tags · one per line",text:$catalog.tags,axis:.vertical).lineLimit(2...4)
                TextField("Applies to · one per line",text:$catalog.appliesTo,axis:.vertical).lineLimit(2...4)
            }
            if let error=catalog.error { Text(error).foregroundStyle(.orange) }
            HStack { Spacer(); Button("Cancel") { catalog.cancelEdit() }.keyboardShortcut(.cancelAction); Button(catalog.createsFile ? "Create skill" : "Save skill") { catalog.save(home:model.home,projectID:activeProjectID) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent).disabled(!catalog.canSave) }
        }.formStyle(.grouped).padding(20).frame(maxWidth:760).frame(maxWidth:.infinity,maxHeight:.infinity)
    }
}

private struct SkillSourceView: View {
    let source: String
    @State private var instructions: String?
    @State private var readError: String?
    @State private var expanded = false
    private var fileURL: URL? { source.hasPrefix("/") ? URL(fileURLWithPath:source) : nil }
    var body: some View {
        DisclosureGroup(isExpanded:$expanded) {
            VStack(alignment:.leading,spacing:12) {
                if let instructions {
                    Text(instructions.isEmpty ? "No instructions in this file." : instructions)
                        .font(.system(size:12,design:.monospaced)).foregroundStyle(.secondary)
                        .textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)
                } else if let readError {
                    Text(readError).font(.caption).foregroundStyle(.secondary)
                } else {
                    ProgressView("Loading…").controlSize(.small)
                }
                Divider()
                Text(source.isEmpty ? "No source" : source)
                    .font(.system(size:11,design:.monospaced)).foregroundStyle(.tertiary)
                    .textSelection(.enabled).fixedSize(horizontal:false,vertical:true)
                HStack {
                if let fileURL {
                    Button("Open file") { NSWorkspace.shared.open(fileURL) }.buttonStyle(.borderless)
                }
                Button("Copy path") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(source,forType:.string)
                }.buttonStyle(.borderless).disabled(source.isEmpty)
                }
            }
            .padding(.top,10)
        } label: {
            Text("Instructions").font(.system(size:13,weight:.medium))
        }
            .task(id:source) {
                instructions = nil; readError = nil
                guard let fileURL else { readError = "This reference is not a local file."; return }
                do {
                    let content = try await Task.detached {
                        let attributes = try FileManager.default.attributesOfItem(atPath:fileURL.path)
                        if (attributes[.size] as? NSNumber)?.intValue ?? 0 > 256_000 {
                            throw NSError(domain:"Skills",code:5,userInfo:[NSLocalizedDescriptionKey:"The skill file is too large to preview."])
                        }
                        return try String(contentsOf:fileURL,encoding:.utf8)
                    }.value
                    guard !Task.isCancelled else { return }
                    instructions = skillInstructions(from:content)
                } catch { readError = "Instructions unavailable: \(error.localizedDescription)" }
            }
    }
}

private extension SkillCatalogModel {
    func values(_ entry: Entry,_ key: String) -> [String] { entry.body[key]?.raw as? [String] ?? [] }
}
