import 'package:finet_mobile/features/update/update_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_receipts.dart';
import '../../support/fake_server.dart';
import '../../support/fake_update.dart';
import '../../support/harness.dart';
import '../../support/scan_rig.dart';

/// Dimensiuni (px logice) și scalări de text verificate: telefon mic, Samsung A56, Pixel.
const _sizes = <(String, Size)>[
  ('360x640', Size(360, 640)),
  ('393x852', Size(393, 852)),
  ('412x915', Size(412, 915)),
];
const _scales = [1.0, 1.3, 2.0];

/// Bara de navigare Android cu 3 butoane (~48 dp): sub ea nu se poate atinge nimic.
const _navBar = 48.0;

/// Ecranul fals: dimensiune logică, `devicePixelRatio` 1, marginea de jos a sistemului și scalarea
/// textului. Se aplică DUPĂ `Harness.pump`, care își fixează singur dimensiunea.
Future<void> setScreen(
  WidgetTester tester,
  Size size,
  double scale, {
  double bottomInset = _navBar,
}) async {
  tester.view.devicePixelRatio = 1.0;
  tester.view.physicalSize = size;
  tester.view.padding = FakeViewPadding(top: 24, bottom: bottomInset);
  tester.view.viewPadding = FakeViewPadding(top: 24, bottom: bottomInset);
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.platformDispatcher.clearAllTestValues);
  await tester.pumpAndSettle();
}

/// Derulează la capăt, oricâte liste derulabile ar fi pe ecran.
Future<void> scrollToEnd(WidgetTester tester) async {
  final scrollable = find.byType(Scrollable).first;
  for (var i = 0; i < 12; i++) {
    await tester.drag(scrollable, const Offset(0, -2000));
    await tester.pumpAndSettle();
  }
}

/// Butonul trebuie să fie întreg deasupra barei de sistem și sub bara de sus.
void expectReachable(WidgetTester tester, Finder f, Size size) {
  expect(f, findsOneWidget);
  final r = tester.getRect(f);
  expect(
    r.bottom,
    lessThanOrEqualTo(size.height - _navBar + 0.5),
    reason: 'butonul e sub bara de navigare ($r)',
  );
  expect(r.top, greaterThanOrEqualTo(kToolbarHeight));
}

Future<ScanRig> openList(WidgetTester tester) async {
  final r = await ScanRig.open(tester, openScan: false);
  await tester.openTab('Mai mult');
  await tester.tapVisible(find.text('Bonuri'));
  return r;
}

Future<void> openReceipt(
  WidgetTester tester,
  String filter,
  String title,
) async {
  await tester.tap(find.widgetWithText(ChoiceChip, filter));
  await tester.pumpAndSettle();
  await tester.tap(find.text(title));
  await tester.pumpAndSettle();
}

void main() {
  group('butonul „Șterge bonul” e accesibil la orice dimensiune', () {
    for (final (name, size) in _sizes) {
      for (final scale in _scales) {
        testWidgets('bon de verificat, $name @ $scale', (tester) async {
          await openList(tester);
          await openReceipt(tester, 'De verificat', 'Mega Image');
          await setScreen(tester, size, scale);
          await scrollToEnd(tester);
          expectReachable(tester, find.text('Șterge bonul'), size);
        });

        testWidgets('bon eșuat/„nu e bon” (gol), $name @ $scale', (
          tester,
        ) async {
          await openList(tester);
          await openReceipt(tester, 'Eșuat', 'Magazin necunoscut');
          await setScreen(tester, size, scale);
          await scrollToEnd(tester);
          expectReachable(tester, find.text('Șterge bonul'), size);
        });
      }
    }

    testWidgets('bon salvat (doar de citit), 360x640 @ 2.0', (tester) async {
      await openList(tester);
      await openReceipt(tester, 'Salvat', 'Kaufland');
      await setScreen(tester, const Size(360, 640), 2.0);
      await scrollToEnd(tester);
      expectReachable(tester, find.text('Șterge bonul'), const Size(360, 640));
    });
  });

  group('ștergere din meniul ⋮ din bara de sus', () {
    testWidgets('bon de verificat: meniu → confirmare → șters', (tester) async {
      final r = await openList(tester);
      await openReceipt(tester, 'De verificat', 'Mega Image');
      await setScreen(tester, const Size(360, 640), 2.0);
      await tester.tap(find.byTooltip('Mai multe'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Șterge bonul').last);
      await tester.pumpAndSettle();
      expect(find.text('Ștergi bonul?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Șterge'));
      await tester.pumpAndSettle();
      expect(r.rec.receipts.containsKey(FakeReceipts.receiptNew), isFalse);
      // S-a întors în listă.
      expect(find.text('Bonuri'), findsWidgets);
    });

    testWidgets('„Nu” la confirmare nu șterge nimic', (tester) async {
      final r = await openList(tester);
      await openReceipt(tester, 'De verificat', 'Mega Image');
      await tester.tap(find.byTooltip('Mai multe'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Șterge bonul').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Nu'));
      await tester.pumpAndSettle();
      expect(r.rec.receipts.containsKey(FakeReceipts.receiptNew), isTrue);
    });

    testWidgets('eroare la încărcarea bonului: meniul rămâne disponibil', (
      tester,
    ) async {
      final r = await openList(tester);
      r.h.server.on(
        'GET /api/v1/receipts/{id}',
        (_) => finetError(500, 'internal', 'Eroare de server.'),
      );
      await tester.tap(find.widgetWithText(ChoiceChip, 'De verificat'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mega Image'));
      await tester.pumpAndSettle();
      expect(find.text('Șterge bonul'), findsNothing);
      await tester.tap(find.byTooltip('Mai multe'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Șterge bonul').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Șterge'));
      await tester.pumpAndSettle();
      expect(r.rec.receipts.containsKey(FakeReceipts.receiptNew), isFalse);
    });
  });

  group('ștergere din lista de bonuri', () {
    testWidgets('meniul de pe element, la text 2.0 și 360x640', (tester) async {
      final r = await openList(tester);
      await setScreen(tester, const Size(360, 640), 2.0);
      // Filtrele sunt în lista derulabilă: bonul de sub ele se ajunge prin derulare.
      await tester.ensureVisible(find.byTooltip('Mai multe').first);
      await tester.pumpAndSettle();
      expectReachable(
        tester,
        find.byTooltip("Mai multe").first,
        const Size(360, 640),
      );
      await tester.tap(find.byTooltip('Mai multe').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Șterge bonul').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Șterge'));
      await tester.pumpAndSettle();
      expect(r.rec.receipts.containsKey(FakeReceipts.receiptNew), isFalse);
      expect(find.text('Mega Image'), findsNothing);
    });
  });

  group('document refuzat („nu e bon”): fără bon, dar se poate șterge', () {
    for (final scale in _scales) {
      testWidgets('buton „Șterge documentul” @ $scale', (tester) async {
        final r = await ScanRig.open(tester);
        r.rec.rejectWith = 'pdf_invalid';
        r.picker.camera.add(photo('doc.jpg'));
        await tester.tapVisible(find.text('Fotografiază bonul'));
        await tester.tapVisible(find.text('Încarcă'));
        await tester.pumpAndSettle();
        await setScreen(tester, const Size(360, 640), scale);
        expect(find.text('Refuzat'), findsOneWidget);
        await scrollToEnd(tester);
        expectReachable(
          tester,
          find.text('Șterge documentul'),
          const Size(360, 640),
        );
        await tester.tap(find.text('Șterge documentul'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Șterge'));
        await tester.pumpAndSettle();
        expect(r.rec.deletedDocuments, hasLength(1));
        expect(find.text('Refuzat'), findsNothing);
      });
    }
  });

  group('ecrane care nu derulau', () {
    testWidgets('„Actualizare necesară” la 360x640 @ 2.0: butonul se atinge', (
      tester,
    ) async {
      final h = Harness(overrides: [])..signedInStore();
      FakeUpdate(h.server).release = FakeUpdate.version(code: 20, min: 10);
      await h.pump(tester);
      await setScreen(tester, const Size(360, 640), 2.0);
      expect(find.byType(UpdateRequiredScreen), findsOneWidget);
      await scrollToEnd(tester);
      expectReachable(
        tester,
        find.widgetWithText(FilledButton, 'Descarcă actualizarea'),
        const Size(360, 640),
      );
    });
  });
}
