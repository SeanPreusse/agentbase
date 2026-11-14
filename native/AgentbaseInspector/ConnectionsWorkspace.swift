import SwiftUI
import AppKit

func codexExecutable(_ configured: String, searchPath: String, home: String) -> String {
    guard configured == "codex" else {return configured}
    let files=FileManager.default
    for directory in searchPath.split(separator:":") {
        let candidate=String(directory)+"/codex"
        if files.isExecutableFile(atPath:candidate) {return candidate}
    }
    #if arch(arm64)
    let platform="macos-aarch64"
    #else
    let platform="macos-x86_64"
    #endif
    for extensions in [".vscode/extensions",".vscode-insiders/extensions"] {
        let folder=home+"/"+extensions
        let entries=((try? files.contentsOfDirectory(atPath:folder)) ?? []).filter {$0.hasPrefix("openai.chatgpt-")}.sorted(by:>)
        for entry in entries {
            let candidate=folder+"/"+entry+"/bin/"+platform+"/codex"
            if files.isExecutableFile(atPath:candidate) {return candidate}
        }
    }
    return configured
}
func claudeExecutable(_ configured: String, searchPath: String) -> String {
    guard configured == "claude" else {return configured}
    for directory in searchPath.split(separator:":") {
        let candidate=String(directory)+"/claude"
        if FileManager.default.isExecutableFile(atPath:candidate) {return candidate}
    }
    return configured
}

struct ConnectionReply: Decodable {
    let ok: Bool; let error: String?
    let codex_available: Bool?; let claude_available: Bool?; let installed: Bool?; let enabled: Bool?; let version: String?
    let install_available: Bool?; let message: String?; let reconnect_required: Bool?
    let tool_count: Int?; let codex_tool_count: Int?; let codex_skill_count: Int?; let checked_workspace: String?; let checked_at: String?; let backup: String?
    let store_path: String?; let store_path_source: String?
}
@MainActor final class ConnectionsModel: ObservableObject {
    @Published var state: ConnectionReply?
    @Published var claudeState: ConnectionReply?
    @Published var busy = false
    @Published var error: String?
    @Published var action = ""
    private(set) var workspaceRoot: String?
    private(set) var storeHome = NSHomeDirectory()+"/.local/share/agentbase"
    func setHome(_ path: String) {
        guard storeHome != path else {return}
        storeHome=path
        state=nil
        claudeState=nil
        error=nil
    }
    func setWorkspace(_ root: String?) {
        guard workspaceRoot != root else {return}
        workspaceRoot = root
        state = nil
        claudeState = nil
        error = nil
    }
    func apply(_ value: ConnectionReply, host: String) {
        if value.ok {if host == "claude" {claudeState=value} else {state=value};error=nil}
        else {error=value.error ?? "Setup could not complete."}
    }
    func startup() {
        run("status", automatically:true)
    }
    func refreshAll() {run("status")}
    func checkAll() {
        if state?.installed == true {run("check")}
        else if claudeState?.installed == true {run("check",host:"claude")}
        else {refreshAll()}
    }
    func run(_ requested: String, host: String = "codex", automatically: Bool = false) {
        let validActions = host == "claude" ? ["status","install","remove","check"] : ["status","install","enable","disable","check"]
        guard !busy, validActions.contains(requested) else {return}
        guard let resources=Bundle.main.resourceURL,
              let data=try? Data(contentsOf:resources.appendingPathComponent("runtime.json")),
              let config=try? JSONSerialization.jsonObject(with:data) as? [String:String],
              let node=config["node"],let source=config["source"] else {error="Setup configuration missing. Rebuild the inspector.";return}
        busy=true;error=nil;action=requested
        let requestedWorkspace = workspaceRoot
        let requestedHome = storeHome
        let process=Process();let output=Pipe();let errors=Pipe()
        let nodePath=bundledPath(node)
        process.executableURL=URL(fileURLWithPath:nodePath)
        var environment=ProcessInfo.processInfo.environment
        environment["PATH"]=[URL(fileURLWithPath:nodePath).deletingLastPathComponent().path,NSHomeDirectory()+"/.local/bin",NSHomeDirectory()+"/.codex/bin","/opt/homebrew/bin","/usr/local/bin",environment["PATH"] ?? "/usr/bin:/bin"].joined(separator:":")
        let codex=codexExecutable(config["codex"] ?? "codex",searchPath:environment["PATH"] ?? "",home:NSHomeDirectory())
        let claude=claudeExecutable(config["claude"] ?? "claude",searchPath:environment["PATH"] ?? "")
        process.arguments=[resources.appendingPathComponent("bridge/connections-main.js").path,requested,"--source",bundledPath(source),"--codex",codex,"--claude",claude,"--node",nodePath,"--host",host,"--home",storeHome]
        if let requestedWorkspace {process.arguments! += ["--workspace",requestedWorkspace]}
        process.environment=environment;process.standardOutput=output;process.standardError=errors
        errors.fileHandleForReading.readabilityHandler={handle in _=handle.availableData}
        do {try process.run()} catch {busy=false;self.error="Could not start setup: \(error.localizedDescription)";return}
        let timeout=Task {try? await Task.sleep(nanoseconds:90_000_000_000);if !Task.isCancelled && process.isRunning {process.terminate()}}
        Task { [weak self] in
            let result=await Task.detached {let bytes=output.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit();return bytes}.value
            timeout.cancel();errors.fileHandleForReading.readabilityHandler=nil
            guard let self else {return};self.busy=false;self.action=""
            guard self.workspaceRoot == requestedWorkspace, self.storeHome == requestedHome else {self.run("status");return}
            do {
                let reply=try JSONDecoder().decode(ConnectionReply.self,from:result)
                self.apply(reply,host:host)
                if reply.ok {
                    if host == "codex" {
                        if automatically && requested == "status" && reply.codex_available == true && reply.installed != true && reply.install_available == true {self.run("install",automatically:true)}
                        else if requested == "status" || (requested == "install" && automatically) {self.run("status",host:"claude",automatically:automatically)}
                        else if (requested == "install" || requested == "enable") && reply.enabled == true {self.run("check",automatically:automatically)}
                        else if requested == "check" && self.claudeState?.installed == true {self.run("check",host:"claude",automatically:automatically)}
                        else if self.claudeState == nil {self.run("status",host:"claude",automatically:automatically)}
                    } else if automatically && requested == "status" && reply.claude_available == true && reply.installed != true && reply.install_available == true {
                        self.run("install",host:"claude",automatically:true)
                    } else if requested == "status" || requested == "install" {
                        if self.state?.installed == true && self.state?.enabled == true && self.state?.checked_at == nil {self.run("check",automatically:automatically)}
                        else if reply.installed == true {self.run("check",host:"claude")}
                    }
                }
            }
            catch {self.error="Setup stopped without a valid result. Refresh to check the current settings."}
        }
    }
}
struct ConnectionsButton: View {
    @ObservedObject var model: ConnectionsModel
    var selectedTask: Entry? = nil
    @State private var presented=false
    var body: some View {
        Button {presented.toggle()} label:{Image(systemName:"puzzlepiece.extension")}
            .buttonStyle(.plain).help("Connections").accessibilityLabel("Connections")
            .popover(isPresented:$presented,arrowEdge:.bottom) {
                VStack(alignment:.leading,spacing:13) {
                    HStack {Text("Connections").font(.headline);Spacer();if model.busy && (model.action != "check" || model.state == nil || model.claudeState == nil) {ProgressView().controlSize(.small)}}
                    HStack(spacing:11) {
                        Image(systemName:"terminal").font(.title3).foregroundStyle(.secondary).frame(width:22)
                        VStack(alignment:.leading,spacing:3) {
                            Text("Codex").font(.system(size:13,weight:.semibold))
                            Text(status).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.state?.installed == true {
                            Toggle("Enable AgentBase in Codex",isOn:Binding(get:{model.state?.enabled == true},set:{model.run($0 ? "enable" : "disable")})).toggleStyle(.switch).labelsHidden().disabled(model.busy)
                        } else if model.state?.codex_available == true {
                            Button("Install") {model.run("install")}.disabled(model.busy || model.state?.install_available != true)
                        }
                    }
                    HStack(spacing:11) {
                        Image(systemName:"sparkle").font(.title3).foregroundStyle(Color(red:0.88,green:0.48,blue:0.31)).frame(width:22)
                        VStack(alignment:.leading,spacing:3) {
                            Text("Claude Code").font(.system(size:13,weight:.semibold))
                            Text(claudeStatus).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.claudeState?.installed == true {
                            Button("Remove") {model.run("remove",host:"claude")}.disabled(model.busy).help("Remove the AgentBase user-level MCP server from Claude Code")
                        } else if model.claudeState?.claude_available == true {
                            Button("Install") {model.run("install",host:"claude")}.disabled(model.busy || model.claudeState?.install_available != true)
                        }
                    }
                    if let warning=storeWarning {Text(warning).font(.caption).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
                    if let error=model.error {Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).fixedSize(horizontal:false,vertical:true)}
                    HStack {
                        Button {model.checkAll()} label:{Image(systemName:"checkmark.circle")}.buttonStyle(.plain).help("Check setup")
                        Spacer()
                        Button {model.refreshAll()} label:{Image(systemName:"arrow.clockwise")}.buttonStyle(.plain).help("Refresh connections")
                    }.font(.caption).disabled(model.busy)
                    DisclosureGroup("Shared memory and data control") {
                        VStack(alignment:.leading,spacing:8) {
                            Text("Codex and Claude Code can read the same projects when their MCP servers use this data folder. Each host still needs its own connection and a new session after setup.")
                            Text("Data folder").fontWeight(.semibold)
                            Text(model.storeHome).font(.caption2.monospaced()).textSelection(.enabled)
                            Text("Codex: \(storeDescription(model.state))")
                            Text("Claude Code: \(storeDescription(model.claudeState))")
                            Text("In either host, ask AgentBase to resume this workspace, save a sourced memory, or review pending memories. Memory capture is an explicit tool action; select a memory node in Graph to review it.")
                            Text("Records have no automatic expiry. Review can reject, supersede, or forget a memory; forgetting removes its content from the active store. Project backups include records and imported dataset copies, but exclude your working files.")
                            Text("The store and backups are local files with restricted permissions. AgentBase does not encrypt them; use an encrypted disk or backup destination if needed. Backup folders contain readable data.")
                        }.font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                    }
                    BringYourOwnAISection(task:selectedTask,home:model.storeHome)
                    if let backup=model.state?.backup {DisclosureGroup("Settings backup") {Text(backup).font(.caption2.monospaced()).textSelection(.enabled)}}
                }.padding(16).frame(width:360)
            }
    }
    var status: String {
        guard let state=model.state else {return model.busy ? "Checking installation…" : "Setup unavailable"}
        if state.codex_available != true {return "Codex CLI not found"}
        if state.installed != true {return "Not installed"}
        let condition = state.enabled == true ? ((state.codex_tool_count ?? 0) > 0 ? "Tools verified" : "Enabled in settings") : "Disabled"
        return condition + (state.version.map {" · \($0)"} ?? "")
    }
    var claudeStatus: String {
        guard let state=model.claudeState else {return model.busy ? "Checking…" : "Not checked"}
        if state.claude_available != true {return "Claude Code CLI not found"}
        if state.installed != true {return "Not installed"}
        return state.message ?? "Installed"
    }
    func storeDescription(_ state: ConnectionReply?) -> String {
        guard let state, state.installed == true else {return "not connected"}
        guard let path=state.store_path else {return "data folder unconfirmed"}
        let origin=state.store_path_source == "default_assumed" ? "likely default" : "configured"
        return "\(path) (\(origin))"
    }
    var storeWarning: String? {
        let hosts=[model.state,model.claudeState].compactMap{$0}.filter{$0.installed == true && $0.enabled == true}
        guard !hosts.isEmpty else {return nil}
        let inspector=URL(fileURLWithPath:model.storeHome).standardizedFileURL.path
        if hosts.contains(where:{$0.store_path_source != "default_assumed" && $0.store_path != nil && URL(fileURLWithPath:$0.store_path!).standardizedFileURL.path != inspector}) {
            return "A host is configured with a different data path. Check that it points to this inspector store before relying on shared memory."
        }
        if hosts.contains(where:{$0.store_path_source == "unknown" || $0.store_path == nil}) {return "A host's data folder could not be verified. Check its MCP configuration before relying on shared memory."}
        if hosts.contains(where:{$0.store_path_source == "default_assumed" && $0.store_path != nil && URL(fileURLWithPath:$0.store_path!).standardizedFileURL.path != inspector}) {
            return "A host likely uses the default data folder, which differs from this inspector store. Check its MCP configuration."
        }
        return nil
    }
}
