// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore
import VisionKit

/// Pairing (D12): scan the QR that `claude-usage pair` shows, or paste its link. The iPhone
/// Camera opening the link lands in the same confirmation. The QR carries a one-time code that is
/// redeemed over HTTPS pinned to the device's certificate; it never carries the access token.
struct PairingScreen: View {
    @Bindable var store: DeckStore
    @State private var pasted = ""
    @State private var scanning = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    scanner
                    pasteField
                    if let error = store.pairingError {
                        Text(error)
                            .font(DeckFont.text(13))
                            .foregroundStyle(DeckColor.warn)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    steps
                    InstallLinks()
                }
                .padding(16)
            }
            .deckScreen()
            .navigationTitle(store.replacingDeviceId == nil ? "Pair a device" : "Re-pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { store.cancelPairing() }
                }
            }
            .overlay {
                if store.pairingInFlight {
                    ProgressView("Pairing…")
                        .padding(20)
                        .background(DeckColor.surface, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
        .confirmPairing(store: store, active: true)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var scanner: some View {
        if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
            QRScanner(active: scanning && store.pendingOffer == nil && !store.pairingInFlight) { code in
                store.offer(PairingInput.classify(code))
            }
            .frame(height: 280)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(DeckColor.line, lineWidth: 1))
            .accessibilityLabel("QR code scanner")
        } else {
            Text("The in-app scanner isn't available here. Point the iPhone Camera at the QR code instead, or paste the link below.")
                .font(DeckFont.text(13))
                .foregroundStyle(DeckColor.muted)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(DeckColor.surface, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private var pasteField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Or paste the pairing link")
                .font(DeckFont.text(12, .medium))
                .foregroundStyle(DeckColor.muted)
            HStack(spacing: 8) {
                TextField("usagedeck://pair?…", text: $pasted)
                    .font(DeckFont.mono(12))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(submitPaste)
                    .padding(10)
                    .background(DeckColor.surface, in: RoundedRectangle(cornerRadius: 9))
                PasteButton(payloadType: String.self) { strings in
                    if let first = strings.first {
                        pasted = first
                        submitPaste()
                    }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.roundedRectangle)
            }
            Button("Pair", action: submitPaste)
                .buttonStyle(.borderedProminent)
                .tint(DeckColor.accent)
                .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("On the device")
                .font(DeckFont.text(12, .medium))
                .foregroundStyle(DeckColor.muted)
            Text(LocalizedStringKey(
                "1. Install claude-usage (see GitHub).\n2. Run `claude-usage install --lan`.\n"
                    + "3. Run `claude-usage pair` and scan its QR code.\n\n"
                    + "Your iPhone and the device need the same Wi-Fi, or the same private network, such as Tailscale, when you are away."
            ))
            .font(DeckFont.text(13))
            .foregroundStyle(DeckColor.fg)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func submitPaste() {
        let text = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let input = PairingInput.classify(text)
        if case .rejected = input {
            // Never keep a pasted v1 code (it holds a live token) in the field.
            pasted = ""
        }
        store.offer(input)
    }
}

/// VisionKit's live QR scanner. Only built when `DataScannerViewController.isSupported` and
/// `isAvailable` (never on the simulator); each distinct payload is reported once.
struct QRScanner: UIViewControllerRepresentable {
    var active: Bool
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        context.coordinator.onCode = onCode
        if active, !scanner.isScanning {
            try? scanner.startScanning()
        } else if !active, scanner.isScanning {
            scanner.stopScanning()
            context.coordinator.last = nil
        }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator _: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        var last: String?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_: DataScannerViewController, didAdd items: [RecognizedItem], allItems _: [RecognizedItem]) {
            for item in items {
                guard case let .barcode(barcode) = item, let payload = barcode.payloadStringValue, payload != last else { continue }
                last = payload
                onCode(payload)
            }
        }
    }
}
