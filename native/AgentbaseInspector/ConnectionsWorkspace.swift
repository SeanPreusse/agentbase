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

struct ConnectionReply: Decodable {
    let ok: Bool; let error: String?
    let codex_available: Bool?; let installed: Bool?; let enabled: Bool?; let version: String?
    let install_available: Bool?; let message: String?; let reconnect_required: Bool?
    let tool_count: Int?; let codex_tool_count: Int?; let codex_skill_count: Int?; let checked_workspace: String?; let checked_at: String?; let backup: String?
}
@MainActor final class ConnectionsModel: ObservableObject {
    @Published var state: ConnectionReply?
    @Published var busy = false
    @Published var error: String?
    @Published var action = ""
    private(set) var workspaceRoot: String?
    func setWorkspace(_ root: String?) {
        guard workspaceRoot != root else {return}
        workspaceRoot = root
        state = nil
        error = nil
    }
    func apply(_ value: ConnectionReply) {
        if value.ok {state=value;error=nil} else {error=value.error ?? "Setup could not complete."}
    }
    func startup() {
        guard let resources=Bundle.main.resourceURL,
              let data=try? Data(contentsOf:resources.appendingPathComponent("runtime.json")),
              let config=try? JSONSerialization.jsonObject(with:data) as? [String:String],
              config["autoInstall"] == "true" else {return}
        run("status", automatically:true)
    }
    func run(_ requested: String, automatically: Bool = false) {
        guard !busy, ["status","install","enable","disable","check"].contains(requested) else {return}
        guard let resources=Bundle.main.resourceURL,
              let data=try? Data(contentsOf:resources.appendingPathComponent("runtime.json")),
              let config=try? JSONSerialization.jsonObject(with:data) as? [String:String],
              let node=config["node"],let source=config["source"] else {error="Setup configuration missing. Rebuild the inspector.";return}
        busy=true;error=nil;action=requested
        let requestedWorkspace = workspaceRoot
        let process=Process();let output=Pipe();let errors=Pipe()
        let nodePath=bundledPath(node)
        process.executableURL=URL(fileURLWithPath:nodePath)
        var environment=ProcessInfo.processInfo.environment
        environment["PATH"]=[URL(fileURLWithPath:nodePath).deletingLastPathComponent().path,NSHomeDirectory()+"/.local/bin",NSHomeDirectory()+"/.codex/bin","/opt/homebrew/bin","/usr/local/bin",environment["PATH"] ?? "/usr/bin:/bin"].joined(separator:":")
        let codex=codexExecutable(config["codex"] ?? "codex",searchPath:environment["PATH"] ?? "",home:NSHomeDirectory())
        process.arguments=[resources.appendingPathComponent("bridge/connections-main.js").path,requested,"--source",bundledPath(source),"--codex",codex]
        if let requestedWorkspace {process.arguments! += ["--workspace",requestedWorkspace]}
        process.environment=environment;process.standardOutput=output;process.standardError=errors
        errors.fileHandleForReading.readabilityHandler={handle in _=handle.availableData}
        do {try process.run()} catch {busy=false;self.error="Could not start setup: \(error.localizedDescription)";return}
        let timeout=Task {try? await Task.sleep(nanoseconds:90_000_000_000);if !Task.isCancelled && process.isRunning {process.terminate()}}
        Task { [weak self] in
            let result=await Task.detached {let bytes=output.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit();return bytes}.value
            timeout.cancel();errors.fileHandleForReading.readabilityHandler=nil
            guard let self else {return};self.busy=false;self.action=""
            guard self.workspaceRoot == requestedWorkspace else {self.run("status");return}
            do {
                let reply=try JSONDecoder().decode(ConnectionReply.self,from:result)
                self.apply(reply)
                if reply.ok {
                    if automatically && requested == "status" && reply.codex_available == true && reply.installed != true && reply.install_available == true {self.run("install",automatically:true)}
                    else if requested == "status" && reply.installed == true && reply.enabled == true {self.run("check")}
                    else if (requested == "install" || requested == "enable") && reply.enabled == true {self.run("check")}
                }
            }
            catch {self.error="Setup stopped without a valid result. Refresh to check the current settings."}
        }
    }
}
struct ConnectionsButton: View {
    @ObservedObject var model: ConnectionsModel
    @State private var presented=false
    var body: some View {
        Button {presented.toggle()} label:{Image(systemName:"puzzlepiece.extension")}
            .buttonStyle(.plain).help("Connections").accessibilityLabel("Connections")
            .popover(isPresented:$presented,arrowEdge:.bottom) {
                VStack(alignment:.leading,spacing:16) {
                    HStack {Text("Connections").font(.headline);Spacer();if model.busy {ProgressView().controlSize(.small)}}
                    HStack(spacing:12) {
                        Image(systemName:"terminal").font(.title2).foregroundStyle(.secondary)
                        VStack(alignment:.leading,spacing:4) {
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
                    if let message=model.state?.message {Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)}
                    if let error=model.error {Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).fixedSize(horizontal:false,vertical:true)}
                    Divider()
                    HStack {
                        Button("Check setup") {model.run("check")}.disabled(model.busy || model.state?.installed != true)
                        Spacer()
                        Button("Refresh") {model.run("status")}.disabled(model.busy)
                    }.font(.caption)
                    Text("User profile · Project policies may override this setting. Changes apply after reconnecting Codex. Switching off keeps your project memory.").font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                    if let backup=model.state?.backup {DisclosureGroup("Settings backup") {Text(backup).font(.caption2.monospaced()).textSelection(.enabled)}}
                }.padding(18).frame(width:340).onAppear {model.run("status")}
            }
    }
    var status: String {
        guard let state=model.state else {return model.busy ? "Checking installation…" : "Setup unavailable"}
        if state.codex_available != true {return "Codex CLI not found"}
        if state.installed != true {return "Not installed"}
        let condition = state.enabled == true ? ((state.codex_tool_count ?? 0) > 0 ? "Tools verified" : "Enabled in settings") : "Disabled"
        return condition + (state.version.map {" · \($0)"} ?? "")
    }
}
