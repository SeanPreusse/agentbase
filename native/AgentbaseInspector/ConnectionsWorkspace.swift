import SwiftUI
import AppKit

struct ConnectionReply: Decodable {
    let ok: Bool; let error: String?
    let codex_available: Bool?; let installed: Bool?; let enabled: Bool?; let version: String?
    let install_available: Bool?; let message: String?; let reconnect_required: Bool?
    let tool_count: Int?; let checked_at: String?; let backup: String?
}
@MainActor final class ConnectionsModel: ObservableObject {
    @Published var state: ConnectionReply?
    @Published var busy = false
    @Published var error: String?
    @Published var action = ""
    func apply(_ value: ConnectionReply) {
        if value.ok {state=value;error=nil} else {error=value.error ?? "Setup could not complete."}
    }
    func run(_ requested: String) {
        guard !busy, ["status","install","enable","disable","check"].contains(requested) else {return}
        guard let resources=Bundle.main.resourceURL,
              let data=try? Data(contentsOf:resources.appendingPathComponent("runtime.json")),
              let config=try? JSONSerialization.jsonObject(with:data) as? [String:String],
              let node=config["node"],let source=config["source"] else {error="Setup configuration missing. Rebuild the inspector.";return}
        busy=true;error=nil;action=requested
        let process=Process();let output=Pipe();let errors=Pipe()
        process.executableURL=URL(fileURLWithPath:node)
        process.arguments=[resources.appendingPathComponent("bridge/connections-main.js").path,requested,"--source",source,"--codex",config["codex"] ?? "codex"]
        var environment=ProcessInfo.processInfo.environment
        environment["PATH"]=[URL(fileURLWithPath:node).deletingLastPathComponent().path,config["codex"].map {URL(fileURLWithPath:$0).deletingLastPathComponent().path} ?? "",environment["PATH"] ?? "/usr/bin:/bin"].joined(separator:":")
        process.environment=environment;process.standardOutput=output;process.standardError=errors
        errors.fileHandleForReading.readabilityHandler={handle in _=handle.availableData}
        do {try process.run()} catch {busy=false;self.error="Could not start setup: \(error.localizedDescription)";return}
        let timeout=Task {try? await Task.sleep(nanoseconds:90_000_000_000);if !Task.isCancelled && process.isRunning {process.terminate()}}
        Task { [weak self] in
            let result=await Task.detached {let bytes=output.fileHandleForReading.readDataToEndOfFile();process.waitUntilExit();return bytes}.value
            timeout.cancel();errors.fileHandleForReading.readabilityHandler=nil
            guard let self else {return};self.busy=false;self.action=""
            do {self.apply(try JSONDecoder().decode(ConnectionReply.self,from:result))}
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
        return (state.enabled == true ? "Enabled" : "Disabled") + (state.version.map {" · \($0)"} ?? "")
    }
}
