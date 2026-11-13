import SwiftUI

struct WorkspaceViewToggle: View {
    @ObservedObject var model: Inspector
    var body: some View {
        Picker("View",selection:Binding(get:{model.viewMode},set:{model.setViewMode($0)})) {
            Text("Graph").tag("Graph")
            Text("Kanban").tag("Kanban")
            Text("Skills").tag("Skills")
        }.pickerStyle(.segmented).labelsHidden().frame(width:205).help("Switch between graph, task board, and skill catalog")
    }
}
struct KanbanColumn: Identifiable {
    let id: String; let title: String
    static let all = [KanbanColumn(id:"proposed",title:"Backlog"),KanbanColumn(id:"ready",title:"Ready"),KanbanColumn(id:"in_progress",title:"In progress"),KanbanColumn(id:"review",title:"Review"),KanbanColumn(id:"blocked",title:"Blocked"),KanbanColumn(id:"done",title:"Done"),KanbanColumn(id:"cancelled",title:"Cancelled")]
    static func visible(for tasks: [Entry], includingClosed: Bool = true) -> [KanbanColumn] {
        all.filter { column in
            if !includingClosed && ["done","cancelled"].contains(column.id) { return false }
            return ["proposed","ready","in_progress","done"].contains(column.id) || tasks.contains(where: {task in task.text("status") == column.id})
        }
    }
}
struct KanbanWorkspace: View {
    @ObservedObject var model: Inspector
    var tasks: [Entry] { model.filteredBoardTasks }
    var columns: [KanbanColumn] { KanbanColumn.visible(for:model.kanbanTasks,includingClosed:model.boardFilter == "All tasks") }
    var body: some View {
        GeometryReader { geometry in
            let width = max(CGFloat(240),min(CGFloat(320),(geometry.size.width-36-CGFloat(columns.count-1)*14)/CGFloat(columns.count)))
            let height = max(CGFloat(250),geometry.size.height-(model.boardHasFilters ? 186 : 116))
            VStack(alignment:.leading,spacing:20) {
                HStack(spacing:12) {
                    Picker("Project",selection:Binding(get:{model.projectID ?? model.snapshot?.selected_project_id ?? ""},set:{model.selectProject($0)})) {
                        if model.projects.isEmpty { Text("No projects").tag("") }
                        Text("All Projects").tag(Inspector.allProjectsID)
                        if let id=model.projectID,id != Inspector.allProjectsID,!model.projects.contains(where:{$0.id==id}) { Text("Project unavailable").tag(id) }
                        ForEach(model.projects) { Text($0.displayName).tag($0.id) }
                    }.labelsHidden().frame(maxWidth:180)
                    WorkspaceViewToggle(model:model)
                    RecentChangesButton(model:model)
                    ConnectionsButton(model:model.connections)
                    Spacer()
                    Picker("Task filter",selection:$model.boardFilter) {ForEach(["Open","Needs attention"],id:\.self){Text($0).tag($0)}}.labelsHidden().frame(width:135)
                    TextField("Search tasks",text:$model.boardQuery).textFieldStyle(.roundedBorder).frame(width:200)
                    Menu {
                        Button("Toggle full screen") {NSApp.keyWindow?.toggleFullScreen(nil)}
                Button(model.paused ? "Resume updates" : "Pause updates",action:model.togglePause)
                        Button("Reconnect") {model.start()}
                        Button("Choose data store…",action:model.chooseStore)
                    } label:{Image(systemName:"ellipsis")}.menuStyle(.borderlessButton).fixedSize().help("Board options")
                }.padding(.horizontal,18).padding(.top,34)
                if model.boardHasFilters {
                    HStack(spacing:10) {
                        Image(systemName:"line.3.horizontal.decrease.circle").foregroundStyle(accent)
                        VStack(alignment:.leading,spacing:3) {
                            Text(model.boardEmptyExplanation ?? "Showing \(tasks.count) of \(model.kanbanTasks.count) tasks").font(.caption.weight(.medium))
                            Text("Filter: \(model.boardFilter)" + (model.boardQuery.isEmpty ? "" : " · Search: \(model.boardQuery)")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                    }.padding(12).background(accent.opacity(0.07),in:RoundedRectangle(cornerRadius:8)).padding(.horizontal,18)
                }
                ScrollView(.horizontal) {
                    HStack(alignment:.top,spacing:14) {
                        ForEach(columns) { column in
                            columnView(column,width:width,height:height)
                        }
                    }.padding(.horizontal,18)
                }
                HStack(spacing:6) {
                    Circle().fill(model.paused || model.failure != nil ? Color.orange : accent).frame(width:4,height:4)
                    Text("\(tasks.count) of \(model.kanbanTasks.count) tasks")
                    if (model.snapshot?.counts["task"] ?? 0)>model.kanbanTasks.count {Text("· \(model.snapshot!.counts["task"]!-model.kanbanTasks.count) older tasks not loaded")}
                    if model.canLoadMoreTasks {Button("Load 200 more",action:model.loadMoreTasks).disabled(model.paused).help(model.paused ? "Resume updates to load more tasks" : "Load older saved tasks (up to 1,000)")}
                    else if (model.snapshot?.counts["task"] ?? 0)>model.kanbanTasks.count {Text("· 1,000-task display limit")}
                    Spacer()
                }.font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary).padding(.horizontal,18).padding(.bottom,12)
            }
        }.background(Color(red:0.045,green:0.055,blue:0.065))
    }
    func columnView(_ column: KanbanColumn,width:CGFloat,height:CGFloat) -> some View {
        let cards=tasks.filter{$0.text("status")==column.id}
        return VStack(alignment:.leading,spacing:12) {
            HStack(spacing:8) {
                Circle().fill(statusColor(column.id)).frame(width:6,height:6)
                Text(column.title).font(.subheadline.weight(.semibold))
                Text("\(cards.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
            }.padding(.horizontal,4)
            ScrollView {LazyVStack(spacing:10) {
                ForEach(cards) {task in card(task)}
                if cards.isEmpty {Text(model.boardQuery.isEmpty && model.boardFilter == "All tasks" ? "No tasks" : "No matches").font(.caption).foregroundStyle(.tertiary).frame(maxWidth:.infinity,alignment:.leading).padding(14)}
            }.padding(.bottom,12)}
        }.padding(12).frame(width:width,height:height,alignment:.topLeading)
         .background(Color.white.opacity(0.025),in:RoundedRectangle(cornerRadius:10))
    }
    func card(_ task: Entry) -> some View {
        Button {model.openRecord(task.id,kind:"task")} label:{
            VStack(alignment:.leading,spacing:10) {
                if model.isAllProjects {Text(model.projectName(for:task.project_id)).font(.caption2.weight(.semibold)).foregroundStyle(accent)}
                Text(task.title).font(.system(size:13,weight:.medium)).foregroundStyle(.primary).multilineTextAlignment(.leading)
                let completion = (task.body["completion"]?.raw as? [String:Any])?["summary"] as? String ?? ""
                let progress = task.text("status") == "done" && !completion.isEmpty ? completion : (task.text("progress").isEmpty ? task.text("description") : task.text("progress"))
                if !progress.isEmpty {Text(progress).font(.caption).foregroundStyle(.secondary).lineLimit(3).multilineTextAlignment(.leading)}
                let blockers=(task.dependencies ?? []).filter{$0["status"]?.text != "done"}
                if !blockers.isEmpty {Label("Waiting for \(blockers.count) task\(blockers.count==1 ? "" : "s")",systemImage:"link").font(.caption2).foregroundStyle(.orange).help(blockers.compactMap{$0["title"]?.text}.joined(separator:", "))}
                if !task.text("owner").isEmpty {HStack {Text(task.text("owner")).lineLimit(1).truncationMode(.middle);Spacer();if task.lease_active != true && ["in_progress","review"].contains(task.text("status")) {Text("Lease expired").foregroundStyle(.orange)}}.font(.system(size:9,design:.monospaced)).foregroundStyle(.secondary)}
            }.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Color.white.opacity(model.selectedID==task.id ? 0.09 : 0.045),in:RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(model.selectedID==task.id ? accent.opacity(0.5) : Color.white.opacity(0.04),lineWidth:1)).contentShape(Rectangle())
        }.buttonStyle(.plain).contextMenu {Button("Show in graph") {model.showInGraph(task.id)}}
    }
}

struct RecentChangesButton: View {
    @ObservedObject var model: Inspector
    @State private var presented = false
    var body: some View {
        Button {presented.toggle()} label:{Image(systemName:"clock.arrow.circlepath")}
            .buttonStyle(.plain).help("Recent changes").accessibilityLabel("Recent changes")
            .popover(isPresented:$presented,arrowEdge:.bottom) {
                VStack(alignment:.leading,spacing:0) {
                    HStack {Text("Recent changes").font(.headline);Spacer();Text("Latest 100").font(.caption).foregroundStyle(.secondary)}.padding(16)
                    Divider()
                    if model.snapshot?.events.isEmpty != false {Text("No saved changes yet").foregroundStyle(.secondary).padding(24)}
                    ScrollView {LazyVStack(spacing:0) {
                        ForEach(model.snapshot?.events ?? []) {event in
                            Button {
                                presented = false
                                model.openRecord(event.record_id,kind:event.record_kind)
                            } label:{
                                VStack(alignment:.leading,spacing:5) {
                                    if model.isAllProjects {Text(model.projectName(for:event.project_id)).font(.caption2.weight(.semibold)).foregroundStyle(accent)}
                                    Text(event.record_title ?? "Record unavailable").font(.system(size:12,weight:.medium)).lineLimit(2)
                                    Text(event.action.replacingOccurrences(of:"_",with:" ") + " · " + event.actor).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                    if let date=ISO8601DateFormatter().date(from:event.at) ?? recentDate(event.at) {Text(date,style:.relative).font(.caption2).foregroundStyle(.tertiary)}
                                }.frame(maxWidth:.infinity,alignment:.leading).padding(12).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(event.record_kind == nil)
                            Divider()
                        }
                    }}
                }.frame(width:360,height:440)
            }
    }
    func recentDate(_ value:String) -> Date? {let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];return formatter.date(from:value)}
}
