import SwiftUI

private func normalizedMemory(_ value: String) -> String {
    value.lowercased().split(whereSeparator: \.isWhitespace).joined(separator:" ")
}

struct MemoryComparison: Identifiable {
    let entry: Entry
    let label: String
    var id: String {entry.id}
}

func memoryComparisons(for entry: Entry, among records: [Entry]) -> [MemoryComparison] {
    let title = normalizedMemory(entry.title), content = normalizedMemory(entry.text("content"))
    return records.compactMap { other in
        guard other.id != entry.id, ["memory","decision"].contains(other.kind), other.text("status") != "forgotten" else {return nil}
        if !content.isEmpty && normalizedMemory(other.text("content")) == content {return MemoryComparison(entry:other,label:"Same content")}
        if !title.isEmpty && normalizedMemory(other.title) == title && normalizedMemory(other.text("content")) != content {
            return MemoryComparison(entry:other,label:"Same title, different content")
        }
        return nil
    }.prefix(8).map{$0}
}

@MainActor final class MemoryActionModel: ObservableObject {
    @Published var busy = false
    @Published var message = ""
    func call(_ tool: String, entry: Entry, home: String, fields: [String:Any], inspector: Inspector) {
        guard !busy else {return}
        busy = true; message = ""
        Task {
            do {
                let configURL = Bundle.main.resourceURL!.appendingPathComponent("runtime.json")
                let config = try JSONSerialization.jsonObject(with: Data(contentsOf:configURL)) as? [String:String]
                guard let node = config?["node"], let source = config?["source"] else {throw NSError(domain:"Memory",code:1,userInfo:[NSLocalizedDescriptionKey:"Runtime configuration is missing."])}
                var input: [String:Any] = ["project_id":entry.project_id,"actor":"inspector","request_id":UUID().uuidString]
                fields.forEach{input[$0.key] = $0.value}
                let payload = try JSONSerialization.data(withJSONObject:input)
                let result = try await Task.detached(priority:.utility) { () throws -> String in
                    let process = Process(), stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
                    process.executableURL = URL(fileURLWithPath:bundledPath(node))
                    process.arguments = [bundledPath(source) + "/bin/agentbase.mjs","--home",home,"call",tool,"-"]
                    process.currentDirectoryURL = URL(fileURLWithPath:"/tmp")
                    process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
                    try process.run()
                    stdin.fileHandleForWriting.write(payload); try stdin.fileHandleForWriting.close()
                    let output = stdout.fileHandleForReading.readDataToEndOfFile()
                    let errors = stderr.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    guard process.terminationStatus == 0 else {
                        let detail = String(decoding:errors.isEmpty ? output : errors,as:UTF8.self)
                        throw NSError(domain:"Memory",code:Int(process.terminationStatus),userInfo:[NSLocalizedDescriptionKey:detail])
                    }
                    return "Saved."
                }.value
                message = result; inspector.start()
            } catch {message = error.localizedDescription}
            busy = false
        }
    }
}

struct MemoryDetail: View {
    @ObservedObject var model: Inspector
    let entry: Entry
    @StateObject private var actions = MemoryActionModel()
    @State private var title: String
    @State private var content: String
    @State private var source: String
    @State private var validFrom: String
    @State private var validUntil: String
    @State private var reason = ""
    init(model: Inspector,entry: Entry) {
        self.model = model; self.entry = entry
        _title = State(initialValue:entry.title); _content = State(initialValue:entry.text("content")); _source = State(initialValue:entry.text("source"))
        _validFrom = State(initialValue:entry.text("valid_from")); _validUntil = State(initialValue:entry.text("valid_until"))
    }
    private var canAct: Bool { !actions.busy && !["forgotten","superseded","rejected"].contains(entry.text("status")) }
    private func review(_ action: String,fields: [String:Any] = [:]) {
        actions.call("memory_review",entry:entry,home:model.home,fields:["id":entry.id,"expected_version":entry.version,"action":action].merging(fields){_,new in new},inspector:model)
    }
    private func update(_ status: String) {
        actions.call("memory_update",entry:entry,home:model.home,fields:["id":entry.id,"expected_version":entry.version,"status":status,"reason":reason],inspector:model)
    }
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            Text(entry.text("content")).textSelection(.enabled)
            Group {
                Text("Source: \(entry.text("source"))")
                Text("Evidence: \(entry.text("epistemic_status")) · Scope: \(entry.text("scope"))")
                if !entry.text("task_id").isEmpty {Button("Task: \(entry.text("task_id"))") {model.openRecord(entry.text("task_id"),kind:"task")}.buttonStyle(.link)}
                if !entry.text("valid_from").isEmpty || !entry.text("valid_until").isEmpty {Text("Valid: \(entry.text("valid_from").isEmpty ? "open" : entry.text("valid_from")) → \(entry.text("valid_until").isEmpty ? "open" : entry.text("valid_until"))")}
                Text("Review: \(entry.text("review_status").isEmpty ? "unreviewed" : entry.text("review_status"))")
                if !entry.text("reviewed_by").isEmpty {Text("Reviewed by \(entry.text("reviewed_by")) · \(timeLabel(entry.text("reviewed_at")))")}
                if !entry.text("status_reason").isEmpty {Text("Status reason: \(entry.text("status_reason"))")}
            }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            let comparisons = memoryComparisons(for:entry,among:model.snapshot?.records ?? [])
            if !comparisons.isEmpty {
                Text("Compare before deciding").font(.headline)
                ForEach(comparisons) { match in
                    Button {model.openRecord(match.id,kind:match.entry.kind)} label: {
                        VStack(alignment:.leading,spacing:3) {
                            Text("\(match.label) · \(match.entry.title)").font(.caption.weight(.semibold))
                            Text(match.entry.text("content")).font(.caption2).lineLimit(2)
                            Text(match.entry.text("source")).font(.caption2).foregroundStyle(.secondary)
                        }.frame(maxWidth:.infinity,alignment:.leading)
                    }.buttonStyle(.plain).padding(8).background(Color.white.opacity(0.05),in:RoundedRectangle(cornerRadius:6))
                }
            }
            if canAct {
                Divider()
                Button("Approve memory") {review("approve")}.disabled(actions.busy)
                Text("Correct or supersede").font(.headline)
                TextField("Title",text:$title)
                TextEditor(text:$content).frame(minHeight:75,maxHeight:140)
                TextField("Source",text:$source)
                HStack {TextField("Valid from · YYYY-MM-DD",text:$validFrom);TextField("Valid until · YYYY-MM-DD",text:$validUntil)}
                HStack {
                    Button("Save correction") {
                        review("edit",fields:["title":title,"content":content,"source":source,"valid_from":validFrom.isEmpty ? NSNull() : validFrom as Any,"valid_until":validUntil.isEmpty ? NSNull() : validUntil as Any,"reason":reason.isEmpty ? "Corrected in inspector." : reason])
                    }.disabled(title.isEmpty || content.isEmpty || source.isEmpty)
                    Button("Supersede") {
                        var fields: [String:Any] = ["kind":entry.text("type"),"title":title,"content":content,"source":source,"epistemic_status":entry.text("epistemic_status"),"scope":entry.text("scope"),"supersedes":entry.id]
                        if !validFrom.isEmpty {fields["valid_from"] = validFrom}
                        if !validUntil.isEmpty {fields["valid_until"] = validUntil}
                        if !entry.text("task_id").isEmpty {fields["task_id"] = entry.text("task_id")}
                        actions.call("memory_record",entry:entry,home:model.home,fields:fields,inspector:model)
                    }.disabled(title.isEmpty || content.isEmpty || source.isEmpty)
                }.buttonStyle(.bordered)
                TextField("Reason for rejection, stale, disputed, or forgetting",text:$reason)
                HStack {
                    Button("Reject") {review("reject",fields:["reason":reason])}
                    Button("Mark stale") {update("stale")}
                    Button("Dispute") {update("disputed")}
                    Button("Forget") {update("forgotten")}.foregroundStyle(.red)
                }.buttonStyle(.bordered).disabled(reason.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                Text("Forgetting removes the stored content. The audit event keeps the action, actor, time, and version.").font(.caption2).foregroundStyle(.secondary)
            }
            let history = (model.snapshot?.events ?? []).filter{$0.record_id == entry.id}.prefix(8)
            if !history.isEmpty {
                Text("Recent changes").font(.headline)
                ForEach(Array(history)) { event in
                    Text("\(event.action.replacingOccurrences(of:"_",with:" ")) · \(event.actor) · \(timeLabel(event.at))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            if !actions.message.isEmpty {Text(actions.message).font(.caption).foregroundStyle(actions.message == "Saved." ? accent : .orange)}
        }
    }
}
