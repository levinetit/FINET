import 'package:finet_mobile/features/statements/statements_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_server.dart';
import '../../support/harness.dart';
import '../../support/scan_rig.dart';

const nbsp = ' ';

Future<ScanRig> openHub(WidgetTester tester) async {
  final r = await ScanRig.open(tester, openScan: false);
  await tester.openTab('Mai mult');
  await tester.tapVisible(find.text('Extrase bancare'));
  return r;
}

/// Alege contul și fișierul, apoi încarcă.
Future<void> importFile(WidgetTester tester, ScanRig r, String name) async {
  r.picker.documents.add(photo(name));
  await tester.tapVisible(find.text('Importă un extras'));
  await tester.tapVisible(find.byType(DropdownButtonFormField<String>));
  await tester.tap(find.text('Cont curent (RON)').last);
  await tester.pumpAndSettle();
  await tester.tapVisible(find.text('Alege fișierul'));
  await tester.tapVisible(
    find.widgetWithText(FilledButton, 'Încarcă extrasul'),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('extrase bancare', () {
    testWidgets('acoperirea arată lunile și lipsurile calculate de server', (
      tester,
    ) async {
      await openHub(tester);
      expect(
        find.text('Contul „Cont curent” nu are extras pentru: 08.2026.'),
        findsOneWidget,
      );
      expect(find.text('09.2026: Complet'), findsOneWidget);
      expect(find.text('10.2026: Parțial, până la 15.10.2026'), findsOneWidget);
      expect(find.text('08.2026: Lipsă'), findsOneWidget);
    });

    testWidgets('CSV recunoscut: previzualizare, apoi confirmare cu cheie', (
      tester,
    ) async {
      final r = await openHub(tester);
      await importFile(tester, r, 'extras.csv');
      // Contul înaintea fișierului în corpul multipart.
      final parts = r.stm.uploads.single;
      expect([for (final p in parts) p.name], ['accountId', 'file']);
      expect(parts.first.text, FakeServer.accCurrent);
      expect(parts.last.filename, 'extras.csv');

      expect(find.text('Plată POS Kaufland'), findsOneWidget);
      expect(
        find.text('2 rânduri noi · 0 duplicate · 2 în total'),
        findsOneWidget,
      );
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Confirmă importul'),
      );
      expect(r.stm.confirmKeys, hasLength(1));
      expect(
        find.text('Extrasul a fost importat: 2 tranzacții.'),
        findsOneWidget,
      );
      expect(
        r.h.server.requestsTo('GET /api/v1/transactions').length,
        greaterThan(1),
      );
    });

    testWidgets('sumele ascunse nu apar în previzualizare', (tester) async {
      final r = await openHub(tester);
      await importFile(tester, r, 'extras.csv');
      expect(find.textContaining('lei'), findsWidgets);
      await tester.tap(find.byTooltip('Ascunde sumele'));
      await tester.pumpAndSettle();
      expect(find.textContaining('lei'), findsNothing);
    });

    testWidgets('sold nepotrivit: confirmarea cere bifa explicită', (
      tester,
    ) async {
      final r = await openHub(tester);
      r.stm.mismatch = true;
      await importFile(tester, r, 'extras.csv');
      FilledButton confirm() => tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Confirmă importul'),
      );
      expect(confirm().onPressed, isNull);
      await tester.tapVisible(find.text('Am verificat, importă oricum'));
      expect(confirm().onPressed, isNotNull);
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Confirmă importul'),
      );
      expect(r.stm.confirmBodies.single['acknowledgeBalanceMismatch'], isTrue);
    });

    testWidgets('schimbul valutar cere o decizie explicită', (tester) async {
      final r = await openHub(tester);
      r.stm.withFx = true;
      await importFile(tester, r, 'extras.csv');
      FilledButton confirm() => tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Confirmă importul'),
      );
      expect(confirm().onPressed, isNull);
      final fxField = find.byType(DropdownButtonFormField<FxChoice>);
      await tester.scrollUntilVisible(fxField, 200);
      await tester.tap(fxField);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sari peste').last);
      await tester.pumpAndSettle();
      expect(confirm().onPressed, isNotNull);
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Confirmă importul'),
      );
      expect(r.stm.confirmBodies.single['fx'], [
        {'rowNo': 3, 'mode': 'skip'},
      ]);
    });

    testWidgets('PDF în coadă: urmărit până la previzualizare', (tester) async {
      final r = await openHub(tester);
      r.stm.nextKind = 'queued';
      await importFile(tester, r, 'extras.pdf');
      expect(find.text('Plată POS Kaufland'), findsOneWidget);
      expect(r.stm.pdfPolls, greaterThanOrEqualTo(2));
    });

    testWidgets('CSV necunoscut: mesaj clar despre asocierea coloanelor', (
      tester,
    ) async {
      final r = await openHub(tester);
      r.stm.nextKind = 'mapping_required';
      await importFile(tester, r, 'ciudat.csv');
      expect(find.textContaining('asocierea coloanelor'), findsOneWidget);
    });

    testWidgets('fișier respins din arhivă: mesajul codului', (tester) async {
      final r = await openHub(tester);
      r.stm.nextKind = 'rejected';
      await importFile(tester, r, 'arhiva.zip');
      // ZIP-ul nu e o extensie acceptată local: mesaj de validare, fără cerere.
      expect(r.stm.uploads, isEmpty);
      expect(
        find.text('Se acceptă PDF, CSV sau XLSX pentru extrase.'),
        findsOneWidget,
      );
    });

    testWidgets('eroare de rețea: reîncercare cu aceiași octeți', (
      tester,
    ) async {
      final r = await openHub(tester);
      r.stm.failUploads = 1;
      await importFile(tester, r, 'extras.csv');
      expect(r.stm.uploadAttempts, 2);
      expect(r.norm.calls['/cache/extras.csv'], 1);
      expect(find.text('Plată POS Kaufland'), findsOneWidget);
    });

    testWidgets('renunțarea la previzualizare o șterge pe server', (
      tester,
    ) async {
      final r = await openHub(tester);
      await importFile(tester, r, 'extras.csv');
      await tester.tapVisible(find.widgetWithText(TextButton, 'Renunță'));
      await tester.tap(find.widgetWithText(FilledButton, 'Renunță'));
      await tester.pumpAndSettle();
      expect(r.stm.discarded, hasLength(1));
    });
  });
}
