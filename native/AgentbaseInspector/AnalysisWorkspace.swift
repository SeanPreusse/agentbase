import SwiftUI
import AppKit
import Charts
import CoreFoundation

struct AnalysisColumn: Identifiable {
    let id:Int;let name:String;let type:String
    var numeric:Bool {type.range(of:"^(U?(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT)|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)",options:.regularExpression) != nil}
    var temporal:Bool {type.hasPrefix("DATE") || type.hasPrefix("TIMESTAMP")}
}
struct AnalysisPoint: Identifiable {
    let id:Int;let label:String;let x:Double;let date:Date?;let y:Double;let valueText:String
}
struct AnalysisData {
    let columns:[AnalysisColumn];let rows:[[Any]];let omitted:Int;let truncated:Bool
    init(_ entry:Entry) {
        columns=(entry.body["columns"]?.raw as? [[String:Any]] ?? []).enumerated().map {AnalysisColumn(id:$0.offset,name:$0.element["name"] as? String ?? "Column",type:($0.element["type"] as? String ?? "").uppercased())}
        rows=entry.body["rows"]?.raw as? [[Any]] ?? []
        omitted=(entry.body["inspector_rows_omitted"]?.raw as? NSNumber)?.intValue ?? 0
        truncated=entry.body["truncated"]?.raw as? Bool ?? false
    }
    static func text(_ value:Any) -> String {
        if value is NSNull {return "null"}
        if let string=value as? String {return string}
        if let number=value as? NSNumber {return number.stringValue}
        if let data=try? JSONSerialization.data(withJSONObject:value,options:[.fragmentsAllowed,.sortedKeys]) {return String(decoding:data,as:UTF8.self)}
        return String(describing:value)
    }
    static func number(_ value:Any,type:String) -> Double? {
        if let number=value as? NSNumber,CFGetTypeID(number)==CFBooleanGetTypeID() {return nil}
        guard value is NSNumber || value is String,let result=Double(text(value)),result.isFinite,abs(result)<=1e100 else {return nil}
        if type.contains("INT") && abs(result)>9_007_199_254_740_991 {return nil}
        return result
    }
    static func date(_ value:Any) -> Date? {
        guard var text=value as? String else {return nil}
        if text.count==10 {text += "T00:00:00Z"} else {text=text.replacingOccurrences(of:" ",with:"T");if text.range(of:"(Z|[+-][0-9]{2}:[0-9]{2})$",options:.regularExpression)==nil {text += "Z"}}
        let iso=ISO8601DateFormatter();iso.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        return iso.date(from:text) ?? ISO8601DateFormatter().date(from:text)
    }
    func points(x:Int,y:Int) -> [AnalysisPoint] {
        guard columns.indices.contains(y) else {return []}
        return rows.enumerated().compactMap {index,row in
            guard row.indices.contains(y),let value=Self.number(row[y],type:columns[y].type) else {return nil}
            if x < 0 {return AnalysisPoint(id:index,label:String(index+1),x:Double(index+1),date:nil,y:value,valueText:Self.text(row[y]))}
            guard columns.indices.contains(x),row.indices.contains(x),!(row[x] is NSNull) else {return nil}
            let column=columns[x];let date=column.temporal ? Self.date(row[x]) : nil
            if column.temporal && date==nil {return nil}
            let numeric=column.numeric ? Self.number(row[x],type:column.type) : Double(index+1)
            guard let numeric else {return nil}
            return AnalysisPoint(id:index,label:Self.text(row[x]),x:numeric,date:date,y:value,valueText:Self.text(row[y]))
        }
    }
    var numericColumns:[AnalysisColumn] {columns.filter(\.numeric)}
    func defaultX(y:Int) -> Int {columns.first(where:{$0.id != y && $0.temporal})?.id ?? columns.first(where:{$0.id != y && !$0.numeric})?.id ?? columns.first(where:{$0.id != y})?.id ?? -1}
}

struct AnalysisWorkspace: View {
    let entry:Entry;let expanded:Bool
    @State private var mode="Chart"
    @State private var style="Bar"
    @State private var x = -1
    @State private var y = -1
    @State private var hovered:Int?
    @State private var samples:[AnalysisPoint]=[]
    var data:AnalysisData {AnalysisData(entry)}
    var points:[AnalysisPoint] {samples}
    var xName:String {data.columns.indices.contains(x) ? data.columns[x].name : "Row"}
    var yName:String {data.columns.indices.contains(y) ? data.columns[y].name : "Value"}
    var temporal:Bool {data.columns.indices.contains(x) && data.columns[x].temporal}
    var continuous:Bool {x<0 || temporal || (data.columns.indices.contains(x) && data.columns[x].numeric)}
    var duplicateBars:Bool {style=="Bar" && Set(points.map(\.label)).count != points.count}
    var ordered:[AnalysisPoint] {style=="Bar" ? points : points.sorted {temporal ? $0.date! < $1.date! : $0.x < $1.x}}
    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            Picker("Result view",selection:$mode) {Text("Chart").tag("Chart");Text("Table").tag("Table")}.pickerStyle(.segmented).labelsHidden().frame(width:160)
            if mode=="Chart" {
                if data.numericColumns.isEmpty {
                    ContentUnavailableView("No numeric columns",systemImage:"chart.bar",description:Text("Use Table to inspect these saved results."))
                } else {
                    HStack(spacing:10) {
                        Picker("X",selection:$x) {Text("Row").tag(-1);ForEach(data.columns){Text($0.name).tag($0.id)}}
                        Picker("Y",selection:$y) {ForEach(data.numericColumns){Text($0.name).tag($0.id)}}
                    }.font(.caption)
                    Picker("Chart type",selection:$style) {Text("Bar").tag("Bar");Text("Line").tag("Line");Text("Scatter").tag("Scatter")}.pickerStyle(.segmented).labelsHidden()
                    if points.isEmpty {Text("No plottable rows for these columns.").font(.caption).foregroundStyle(.secondary)}
                    else if duplicateBars {Text("Repeated X values. Choose a distinct column, use Scatter, or group the result in SQL before drawing bars.").font(.caption).foregroundStyle(.secondary)}
                    else if style != "Bar" && !continuous {Text("Choose a numeric or date X column for Line or Scatter.").font(.caption).foregroundStyle(.secondary)}
                    else {plot.frame(height:expanded ? 430 : 260)}
                    if points.count < data.rows.count {Text("\(data.rows.count-points.count) rows have missing or unsupported axis values and are not plotted.").font(.caption2).foregroundStyle(.secondary)}
                }
            } else {table}
            Text("\(data.rows.count) saved rows loaded" + (data.omitted>0 ? " · \(data.omitted) more saved rows outside this view" : "") + (data.truncated ? " · Query result was truncated when saved" : "")).font(.caption2).foregroundStyle(data.truncated || data.omitted>0 ? .orange : .secondary)
            if let point=points.first(where:{$0.id==hovered}) {Text("\(xName): \(point.label) · \(yName): \(point.valueText)").font(.caption.monospacedDigit()).textSelection(.enabled)}
        }.onAppear {configure()}.onChange(of:data.columns.map(\.name)) {_,_ in configure()}
         .onChange(of:x) {_,_ in refresh()}.onChange(of:y) {_,_ in refresh()}
         .onChange(of:data.rows.count) {_,_ in refresh()}.onChange(of:entry.version) {_,_ in refresh()}
    }
    var plot: some View {
        Chart(ordered) {point in
            if style=="Bar" {BarMark(x:.value(xName,point.label),y:.value(yName,point.y)).foregroundStyle(accent)}
            else if temporal {
                if style=="Line" {LineMark(x:.value(xName,point.date!),y:.value(yName,point.y)).foregroundStyle(accent)}
                PointMark(x:.value(xName,point.date!),y:.value(yName,point.y)).foregroundStyle(accent).symbolSize(point.id==hovered ? 65 : 20)
            } else {
                if style=="Line" {LineMark(x:.value(xName,point.x),y:.value(yName,point.y)).foregroundStyle(accent)}
                PointMark(x:.value(xName,point.x),y:.value(yName,point.y)).foregroundStyle(accent).symbolSize(point.id==hovered ? 65 : 20)
            }
        }.chartXAxisLabel(xName).chartYAxisLabel(yName).chartYScale(domain:.automatic(includesZero:style=="Bar"))
         .accessibilityLabel("\(style) chart of \(yName) by \(xName), \(points.count) saved rows")
         .chartOverlay {proxy in GeometryReader {geometry in
             Rectangle().fill(.clear).contentShape(Rectangle()).onContinuousHover {phase in
                 guard let anchor=proxy.plotFrame else {return};let frame=geometry[anchor]
                 switch phase {
                 case .active(let location):
                     guard frame.contains(location) else {hovered=nil;return}
                     hovered=points.min {a,b in
                         func position(_ point:AnalysisPoint) -> CGFloat {if style=="Bar" {return proxy.position(forX:point.label) ?? 0};if temporal {return proxy.position(forX:point.date!) ?? 0};return proxy.position(forX:point.x) ?? 0}
                         return abs(position(a)-(location.x-frame.minX)) < abs(position(b)-(location.x-frame.minX))
                     }?.id
                 case .ended:hovered=nil
                 }
             }
         }}
    }
    var table: some View {
        GeometryReader {geometry in ScrollView([.horizontal,.vertical]) {LazyVStack(alignment:.leading,spacing:0,pinnedViews:[.sectionHeaders]) {
            Section {
                ForEach(Array(data.rows.enumerated()),id:\.offset){index,row in HStack(spacing:0) {ForEach(data.columns){column in Text(row.indices.contains(column.id) ? AnalysisData.text(row[column.id]) : "null").font(.system(.caption,design:.monospaced)).lineLimit(3).frame(width:150,alignment:.leading).padding(8).background(index.isMultiple(of:2) ? Color.secondary.opacity(0.04) : .clear)}}}
            } header:{HStack(spacing:0) {ForEach(data.columns){column in Text(column.name).font(.caption.bold()).frame(width:150,alignment:.leading).padding(8)}}.background(Color(red:0.10,green:0.16,blue:0.19))}
        }.frame(minWidth:geometry.size.width,minHeight:geometry.size.height,alignment:.topLeading).textSelection(.enabled)}}.frame(height:expanded ? 480 : 300)
    }
    func refresh() {hovered=nil;samples=data.points(x:x,y:y)}
    func configure() {
        y=data.numericColumns.first?.id ?? -1;x=data.defaultX(y:y)
        style=(data.columns.indices.contains(x) && data.columns[x].temporal) ? "Line" : "Bar"
        refresh()
    }
}

struct DetailPanelPlacement {
    static func clamped(_ point:CGPoint,size:CGSize,container:CGSize) -> CGPoint {
        CGPoint(x:min(max(12,point.x),max(12,container.width-size.width-12)),y:min(max(34,point.y),max(34,container.height-size.height-18)))
    }
}

struct DetailDragHandle: NSViewRepresentable {
    let changed:(CGSize)->Void;let ended:(CGSize)->Void;let doubleClick:()->Void
    func makeNSView(context:Context)->Surface {let view=Surface();updateNSView(view,context:context);return view}
    func updateNSView(_ view:Surface,context:Context) {view.changed=changed;view.ended=ended;view.doubleClick=doubleClick}
    final class Surface:NSView {
        var changed:((CGSize)->Void)?;var ended:((CGSize)->Void)?;var doubleClick:(()->Void)?
        private var origin:CGPoint?
        override var mouseDownCanMoveWindow:Bool {false}
        override func acceptsFirstMouse(for event:NSEvent?)->Bool {true}
        override func mouseDown(with event:NSEvent) {if event.clickCount==2 {origin=nil;doubleClick?()} else {origin=event.locationInWindow}}
        override func mouseDragged(with event:NSEvent) {guard let origin else {return};changed?(CGSize(width:event.locationInWindow.x-origin.x,height:origin.y-event.locationInWindow.y))}
        override func mouseUp(with event:NSEvent) {guard let origin else {return};ended?(CGSize(width:event.locationInWindow.x-origin.x,height:origin.y-event.locationInWindow.y));self.origin=nil}
    }
}
