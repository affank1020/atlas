import SwiftUI
import AppKit
import Combine
import Foundation

// The UI is a thin local companion to atlasctl. It never reads Node credentials,
// enrolment tokens, or the .env.node file.
private struct ServiceState: Decodable {
    let state: String
    let detail: String?
}
private struct LaunchAgentState: Decodable {
    let supported: Bool
    let installed: Bool
    let loaded: Bool
    let pid: Int?
    let state: String?
    let lastExit: Int?
}
private struct ConnectionStatus: Decodable {
    let state: String
    let detail: String?
    let pid: Int?
    let changedAt: String?
    let updatedAt: String?
}
private struct NodeSnapshot: Decodable {
    let hosted: ServiceState
    let local: ServiceState
    let launchd: LaunchAgentState
    let connection: ConnectionStatus
    let unmanagedNodeCount: Int
    let target: String
    let webUrl: String
}

private final class NodeControlModel: ObservableObject {
    @Published private(set) var snapshot: NodeSnapshot?
    @Published private(set) var logs = "Loading Node logs…"
    @Published private(set) var working = false
    @Published private(set) var message: String?
    private var refreshing = false

    private var repository: URL? {
        guard let path = Bundle.main.object(forInfoDictionaryKey: "AtlasRepositoryPath") as? String else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private func command(_ arguments: [String], finished: @escaping (Int32, String) -> Void) {
        guard let repository else {
            finished(1, "Atlas repository path is missing from the application.")
            return
        }
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.executableURL = repository.appendingPathComponent("atlasctl")
            process.currentDirectoryURL = repository
            process.arguments = arguments
            let output = Pipe()
            process.standardOutput = output
            process.standardError = output
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let result = String(data: data, encoding: .utf8) ?? "Could not decode command output."
                DispatchQueue.main.async { finished(process.terminationStatus, result) }
            } catch {
                DispatchQueue.main.async { finished(1, error.localizedDescription) }
            }
        }
    }

    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        command(["status", "--json"]) { [weak self] code, output in
            guard let self else { return }
            self.refreshing = false
            if code == 0, let data = output.data(using: .utf8),
               let parsed = try? JSONDecoder().decode(NodeSnapshot.self, from: data) {
                self.snapshot = parsed
            } else {
                self.message = "Status unavailable: " + String(output.prefix(400))
            }
        }
    }

    func reloadLogs() {
        command(["logs", "node"]) { [weak self] _, output in
            self?.logs = String(output.suffix(24000))
        }
    }

    func perform(_ arguments: [String]) {
        guard !working else { return }
        working = true
        message = nil
        command(arguments) { [weak self] code, output in
            guard let self else { return }
            self.working = false
            self.message = (code == 0 ? "Completed: " : "Command failed: ") + String(output.suffix(750)).trimmingCharacters(in: .whitespacesAndNewlines)
            self.refresh()
            self.reloadLogs()
        }
    }

    func openWeb() {
        guard let raw = snapshot?.webUrl, let url = URL(string: raw),
              url.scheme == "https" else {
            message = "Hosted Atlas URL is unavailable."
            return
        }
        NSWorkspace.shared.open(url)
    }

    var connectionLabel: String {
        switch snapshot?.connection.state {
        case "connected": return "Connected to Atlas Hosted"
        case "reconnecting": return "Reconnecting to Atlas Hosted"
        case "connecting": return "Connecting to Atlas Hosted"
        case "stopping": return "Stopping"
        default: return "Connection unverified"
        }
    }
    var connectionColor: Color {
        switch snapshot?.connection.state {
        case "connected": return .green
        case "reconnecting", "connecting": return .orange
        default: return .secondary
        }
    }
    var nodeRunning: Bool { snapshot?.hosted.state == "running" }
}

private struct InformationRow: View {
    let name: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(name).foregroundStyle(.secondary).frame(width: 138, alignment: .leading)
            Text(value).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.system(size: 12))
    }
}

private struct NodeDashboard: View {
    @EnvironmentObject private var model: NodeControlModel
    @State private var pending: [String]?
    @State private var confirming = false
    private let refreshTimer = Timer.publish(every: 6, on: .main, in: .common).autoconnect()

    private func confirm(_ command: [String]) {
        pending = command
        confirming = true
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Atlas Node").font(.title.bold())
                    Text("Local control and connection diagnostics")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button { model.openWeb() } label: {
                    Label("Open Atlas", systemImage: "arrow.up.right.square")
                }
                Button { model.refresh(); model.reloadLogs() } label: {
                    Image(systemName: "arrow.clockwise")
                }.help("Refresh status and logs")
            }

            GroupBox {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 10) {
                        Circle().fill(model.connectionColor).frame(width: 11, height: 11)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(model.connectionLabel).font(.headline)
                            Text(model.snapshot?.connection.detail?.isEmpty == false
                                 ? (model.snapshot?.connection.detail ?? "")
                                 : "Live status is reported locally by the Node")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.working { ProgressView().controlSize(.small) }
                    }
                    Divider()
                    InformationRow(name: "Node process", value: (model.snapshot?.hosted.state ?? "unknown").capitalized
                                   + (model.snapshot?.hosted.detail.map { " · " + $0 } ?? ""))
                    InformationRow(name: "LaunchAgent", value: model.snapshot?.launchd.loaded == true
                                   ? "Loaded" : (model.snapshot?.launchd.installed == true ? "Installed, not loaded" : "Not installed"))
                    InformationRow(name: "Node PID", value: model.snapshot?.connection.pid.map(String.init) ?? "—")
                    InformationRow(name: "Last transition", value: model.snapshot?.connection.changedAt ?? "—")
                    if (model.snapshot?.unmanagedNodeCount ?? 0) > 0 {
                        Label("Another unmanaged Node process was detected. Atlas Control will leave it alone.",
                              systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }.padding(8)
            }

            HStack(spacing: 9) {
                Button {
                    model.perform(["up"])
                } label: {
                    Label("Start", systemImage: "play.fill")
                }.disabled(model.working || model.nodeRunning)
                Button {
                    confirm(["restart"])
                } label: {
                    Label("Restart", systemImage: "arrow.clockwise")
                }.disabled(model.working)
                Button(role: .destructive) {
                    confirm(["down"])
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }.disabled(model.working || !model.nodeRunning)
                Spacer()
                if model.snapshot?.launchd.installed == true {
                    Button("Remove Auto-start") { confirm(["launchd", "uninstall"]) }
                        .disabled(model.working)
                } else {
                    Button("Enable Auto-start") { confirm(["launchd", "install"]) }
                        .disabled(model.working)
                }
            }
            Text("Start, Stop and Restart act only on the hosted Node. They do not control running football training jobs, and restarting may interrupt them.")
                .font(.caption).foregroundStyle(.secondary)

            if let message = model.message, !message.isEmpty {
                Text(message).font(.caption).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack {
                Text("Recent Node logs").font(.headline)
                Spacer()
                Button("Reload Logs") { model.reloadLogs() }
            }
            ScrollView {
                Text(model.logs.isEmpty ? "No logs recorded yet." : model.logs)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(minHeight: 180)
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.18)))
        }
        .padding(22)
        .frame(minWidth: 650, minHeight: 560)
        .onAppear { model.refresh(); model.reloadLogs() }
        .onReceive(refreshTimer) { _ in model.refresh() }
        .confirmationDialog("Change Atlas Node?", isPresented: $confirming) {
            Button("Continue", role: pending?.contains("down") == true ? .destructive : nil) {
                if let pending { model.perform(pending) }
                pending = nil
            }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: {
            Text("This may interrupt running development commands or training. The existing Node identity and credential are preserved.")
        }
    }
}

@main
struct AtlasNodeApplication: App {
    @StateObject private var model = NodeControlModel()
    var body: some Scene {
        MenuBarExtra {
            MenuContent()
                .environmentObject(model)
        } label: {
            Image(systemName: model.snapshot?.connection.state == "connected"
                  ? "network" : "network.slash")
        }
        Window("Atlas Node", id: "dashboard") {
            NodeDashboard()
                .environmentObject(model)
        }
        .defaultSize(width: 720, height: 630)
    }
}

private struct MenuContent: View {
    @EnvironmentObject private var model: NodeControlModel
    @Environment(\.openWindow) private var openWindow
    private let timer = Timer.publish(every: 10, on: .main, in: .common).autoconnect()

    var body: some View {
        Text(model.connectionLabel)
        Text(model.nodeRunning ? "Local process running" : "Local process stopped")
        Divider()
        Button("Open Control Window") {
            openWindow(id: "dashboard")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Open Atlas Web") { model.openWeb() }
        Button("Refresh Status") { model.refresh() }
        Divider()
        Button("Start Node") { model.perform(["up"]) }.disabled(model.working || model.nodeRunning)
        Button("Restart Node…") {
            openWindow(id: "dashboard")
            NSApp.activate(ignoringOtherApps: true)
        }.disabled(model.working)
        Divider()
        Button("Quit Atlas Node UI") { NSApp.terminate(nil) }
            .onReceive(timer) { _ in model.refresh() }
            .onAppear { model.refresh() }
    }
}
