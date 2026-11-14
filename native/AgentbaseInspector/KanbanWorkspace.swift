import SwiftUI

struct WorkspaceViewToggle: View {
    @ObservedObject var model: Inspector
    var body: some View {
        Picker("View",selection:Binding(get:{model.viewMode},set:{model.setViewMode($0)})) {
            Text("Graph").tag("Graph")
            Text("Tasks").tag("Kanban")
            Text("Skills").tag("Skills")
        }.pickerStyle(.segmented).labelsHidden().frame(width:225).help("Switch between graph, tasks, and skills")
    }
}
struct WorkspaceNavigation: View {
    @ObservedObject var model: Inspector
    var projectDisabled = false
    var body: some View {
        HStack(spacing:10) {
            Picker("Project",selection:Binding(get:{model.projectID ?? model.snapshot?.selected_project_id ?? ""},set:{model.selectProject($0)})) {
                if model.projects.isEmpty {Text("No projects").tag("")}
                Text("All Projects").tag(Inspector.allProjectsID)
                if let id=model.projectID,id != Inspector.allProjectsID,!model.projects.contains(where:{$0.id==id}) {Text("Project unavailable").tag(id)}
                ForEach(model.projects) {Text($0.displayName).tag($0.id)}
            }.pickerStyle(.menu).labelsHidden().frame(width:180).disabled(projectDisabled).help(model.projectFolder)
            WorkspaceViewToggle(model:model)
        }.frame(height:32)
    }
}
struct KanbanColumn: Identifiable {
    let id: String; let title: String
    static let queue = KanbanColumn(id:"queue",title:"Queue")
    static let active = KanbanColumn(id:"active",title:"Active")
    static let attention = KanbanColumn(id:"attention",title:"Needs attention")
    static let done = KanbanColumn(id:"done",title:"Done")
    static func placement(for task: Entry) -> String {
        let status = task.text("status")
        if ["done","cancelled"].contains(status) {return "done"}
        let waiting = (task.dependencies ?? []).contains(where: {$0["status"]?.text != "done"})
        let expired = !task.text("owner").isEmpty && task.lease_active == false && ["in_progress","review"].contains(status)
        if status == "blocked" || status == "review" || waiting || expired {return "attention"}
        return status == "in_progress" ? "active" : "queue"
    }
}
struct KanbanWorkspace: View {
    @ObservedObject var model: Inspector
    var tasks: [Entry] { model.filteredBoardTasks }
    var columns: [KanbanColumn] {
        if model.boardFilter == "Done" {return [.done]}
        if model.boardFilter == "Needs attention" {return [.attention]}
        if model.boardFilter == "All" {return [.queue,.active,.attention,.done]}
        return [.queue,.active,.attention]
    }
    var body: some View {
        GeometryReader { geometry in
            let width = max(CGFloat(240),min(CGFloat(320),(geometry.size.width-36-CGFloat(columns.count-1)*14)/CGFloat(columns.count)))
            let height = max(CGFloat(250),geometry.size.height-(model.boardHasFilters ? 186 : 116))
            VStack(alignment:.leading,spacing:20) {
                HStack(spacing:12) {
                    WorkspaceNavigation(model:model)
                    RecentChangesButton(model:model)
                    ConnectionsButton(model:model.connections,selectedTask:model.selected?.kind == "task" ? model.selected : nil)
                    Spacer()
                    Picker("Status",selection:$model.boardFilter) {ForEach(["All","Open","Needs attention","Done"],id:\.self){Text($0).tag($0)}}.pickerStyle(.menu).frame(width:180).help("All includes tasks in every status; choose a project to show one workspace or All Projects to combine them.")
                    TextField("Search tasks",text:$model.boardQuery).textFieldStyle(.roundedBorder).frame(width:200)
                    Menu {
                        Button("Toggle full screen") {NSApp.keyWindow?.toggleFullScreen(nil)}
                Button(model.paused ? "Resume updates" : "Pause updates",action:model.togglePause)
                        Button("Reconnect") {model.start()}
                        Button("Choose data store…",action:model.chooseStore)
                    } label:{Image(systemName:"ellipsis")}.menuStyle(.borderlessButton).fixedSize().help("Board options")
                }.padding(.leading,30).padding(.trailing,18).padding(.top,43)
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
                }.font(.system(size:10,design:.monospaced)).foregroundStyle(.secondary).padding(.leading,62).padding(.trailing,18).padding(.bottom,12)
            }
        }.background(Color(red:0.045,green:0.055,blue:0.065))
    }
    func columnView(_ column: KanbanColumn,width:CGFloat,height:CGFloat) -> some View {
        let cards=tasks.filter{KanbanColumn.placement(for:$0)==column.id}
        return VStack(alignment:.leading,spacing:12) {
            HStack(spacing:8) {
                Circle().fill(statusColor(column.id)).frame(width:6,height:6)
                Text(column.title).font(.subheadline.weight(.semibold))
                Text("\(cards.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
            }.padding(.horizontal,4)
            ScrollView {LazyVStack(spacing:10) {
                ForEach(cards) {task in card(task)}
                if cards.isEmpty {Text(model.boardQuery.isEmpty && ["Open","All"].contains(model.boardFilter) ? "No tasks" : "No matches").font(.caption).foregroundStyle(.tertiary).frame(maxWidth:.infinity,alignment:.leading).padding(14)}
            }.padding(.bottom,12)}
        }.padding(12).frame(width:width,height:height,alignment:.topLeading)
         .background(Color.white.opacity(0.025),in:RoundedRectangle(cornerRadius:10))
    }
    func card(_ task: Entry) -> some View {
        Button {model.openRecord(task.id,kind:"task")} label:{
            VStack(alignment:.leading,spacing:10) {
                Text(model.projectName(for:task.project_id)).font(.caption2.weight(.semibold)).foregroundStyle(accent).lineLimit(1).help("Project: \(model.projectName(for:task.project_id))")
                if !task.text("parent_task_id").isEmpty {
                    Label("Subtask of \(parentTitle(for:task))",systemImage:"arrow.turn.down.right")
                        .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
                Text(task.title).font(.system(size:13,weight:.medium)).foregroundStyle(.primary).multilineTextAlignment(.leading)
                if !task.text("status").isEmpty {StatusBadge(value:task.text("status"))}
                let completion = (task.body["completion"]?.raw as? [String:Any])?["summary"] as? String ?? ""
                let progress = task.text("status") == "done" && !completion.isEmpty ? completion : (task.text("progress").isEmpty ? task.text("description") : task.text("progress"))
                if !progress.isEmpty {Text(progress).font(.caption).foregroundStyle(.secondary).lineLimit(3).multilineTextAlignment(.leading)}
                if task.text("status") == "blocked" {
                    let reason = task.text("reason").isEmpty ? task.text("blocked_reason") : task.text("reason")
                    Label(reason.isEmpty ? "Waiting for input" : reason,systemImage:"pause.circle")
                        .font(.caption2).foregroundStyle(.orange).lineLimit(3).multilineTextAlignment(.leading)
                }
                let blockers=(task.dependencies ?? []).filter{$0["status"]?.text != "done"}
                if !blockers.isEmpty {Label("Waiting for \(blockers.count) task\(blockers.count==1 ? "" : "s")",systemImage:"link").font(.caption2).foregroundStyle(.orange).help(blockers.compactMap{$0["title"]?.text}.joined(separator:", "))}
                if !task.text("owner").isEmpty {HStack {Text(task.text("owner")).lineLimit(1).truncationMode(.middle);Spacer();if task.lease_active != true && ["in_progress","review"].contains(task.text("status")) {Text("Lease expired").foregroundStyle(.orange)}}.font(.system(size:9,design:.monospaced)).foregroundStyle(.secondary)}
            }.padding(14).frame(maxWidth:.infinity,alignment:.leading).background(Color.white.opacity(model.selectedID==task.id ? 0.09 : 0.045),in:RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(model.selectedID==task.id ? accent.opacity(0.5) : Color.white.opacity(0.04),lineWidth:1)).contentShape(Rectangle())
        }.buttonStyle(.plain).contextMenu {Button("Show in graph") {model.showInGraph(task.id)}}
    }
    func parentTitle(for task: Entry) -> String {
        let id=task.text("parent_task_id")
        return model.snapshot?.records.first(where:{$0.id==id})?.title
            ?? model.snapshot?.graph?.nodes.first(where:{$0.id==id})?.title
            ?? "parent task"
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
