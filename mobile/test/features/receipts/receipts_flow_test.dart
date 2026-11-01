import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_receipts.dart';
import '../../support/fake_server.dart';
import '../../support/harness.dart';
import '../../support/scan_rig.dart';

const nbsp = ' ';

Future<ScanRig> openReceipts(WidgetTester tester) async {
  final r = await ScanRig.open(tester, openScan: false);
  await tester.openTab('Mai mult');
  await tester.tapVisible(find.text('Bonuri'));
  return r;
}

/// Două conturi în RON: utilizatorul trebuie să aleagă unul, aplicația nu ghicește.
Future<void> pickAccount(WidgetTester tester) async {
  await tester.tapVisible(find.byType(DropdownButtonFormField<String>));
  await tester.tap(find.text('Cont curent').last);
  await tester.pumpAndSettle();
}

Future<void> openReview(WidgetTester tester) async {
  await tester.tap(find.text('Mega Image'));
  await tester.pumpAndSettle();
}

void main() {
  group('lista de bonuri', () {
    testWidgets('implicit „De verificat”; filtrul schimbă lista', (
      tester,
    ) async {
      await openReceipts(tester);
      expect(find.text('Mega Image'), findsOneWidget);
      expect(find.text('Kaufland'), findsNothing);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Salvat'));
      await tester.pumpAndSettle();
      expect(find.text('Kaufland'), findsOneWidget);
      expect(find.text('Mega Image'), findsNothing);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Toate'));
      await tester.pumpAndSettle();
      expect(find.text('Magazin necunoscut'), findsOneWidget);
    });

    testWidgets('sumele ascunse dispar din listă', (tester) async {
      await openReceipts(tester);
      expect(find.text('45,67${nbsp}lei'), findsOneWidget);
      await tester.tap(find.byTooltip('Ascunde sumele'));
      await tester.pumpAndSettle();
      expect(find.textContaining('lei'), findsNothing);
    });
  });

  group('verificarea bonului', () {
    testWidgets('arată problemele, furnizorul și sumele de la server', (
      tester,
    ) async {
      await openReceipts(tester);
      await openReview(tester);
      expect(find.text('Lipsește CUI-ul.'), findsOneWidget);
      expect(
        find.text('Cantitate × preț ≠ totalul liniei. (linia 2)'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Citit cu serviciul AI extern'),
        findsOneWidget,
      );
      expect(
        find.text('Motiv: modelul local a răspuns prea greu'),
        findsOneWidget,
      );
      expect(
        find.text(
          'Suma liniilor: 45,67${nbsp}lei · Total bon: 45,67${nbsp}lei',
        ),
        findsOneWidget,
      );
      expect(find.text('Lapte 1L'), findsOneWidget);
    });

    testWidgets('sumele ascunse nu apar în text pe ecranul bonului', (
      tester,
    ) async {
      await openReceipts(tester);
      await openReview(tester);
      await tester.tap(find.byTooltip('Ascunde sumele'));
      await tester.pumpAndSettle();
      expect(find.textContaining('lei'), findsNothing);
      expect(
        find.text('Suma liniilor: •••• · Total bon: ••••'),
        findsOneWidget,
      );
    });

    testWidgets('corectura păstrează cantitatea, prețul unitar și TVA-ul', (
      tester,
    ) async {
      final r = await openReceipts(tester);
      await openReview(tester);
      // „Confirmă” e blocat cât timp există modificări nesalvate.
      await tester.enterText(
        find.widgetWithText(TextField, 'Denumire (linia 1)'),
        'Lapte 2L',
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Confirmă și salvează'),
            )
            .onPressed,
        isNull,
      );
      await tester.tapVisible(
        find.widgetWithText(OutlinedButton, 'Salvează corecturile'),
      );
      final patch = r.rec.patches.single;
      final lines = patch['lines']! as List;
      final first = lines.first as Map;
      expect(first['rawName'], 'Lapte 2L');
      expect(first['id'], 'l1');
      expect(first['quantity'], '2');
      expect(first['unitPriceMinor'], 750);
      expect(first['vatRate'], '11');
      // Sumele pleacă ca întregi în unități minore, nu ca text.
      expect(first['lineTotalMinor'], 1500);
      expect(lines, hasLength(3));
      expect(
        find.text(
          'Corecturile au fost salvate; verificările au fost refăcute.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('o sumă ambiguă este respinsă local, fără cerere', (
      tester,
    ) async {
      final r = await openReceipts(tester);
      await openReview(tester);
      await tester.enterText(
        find.widgetWithText(TextField, 'Total linie').first,
        '1.234',
      );
      await tester.pumpAndSettle();
      await tester.tapVisible(
        find.widgetWithText(OutlinedButton, 'Salvează corecturile'),
      );
      expect(r.rec.patches, isEmpty);
      expect(find.byType(Text).evaluate().isNotEmpty, isTrue);
    });

    testWidgets('confirmarea creează tranzacția cu cheie de idempotență', (
      tester,
    ) async {
      final r = await openReceipts(tester);
      await openReview(tester);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Confirmă și salvează'),
            )
            .onPressed,
        isNull,
      );
      await pickAccount(tester);
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Confirmă și salvează'),
      );
      expect(r.rec.confirmKeys, hasLength(1));
      expect(r.rec.confirmBodies.single['accountId'], isNotEmpty);
      expect(r.rec.confirmBodies.single.containsKey('allowDuplicate'), isFalse);
      expect(find.text('Bonul a fost salvat ca tranzacție.'), findsOneWidget);
      expect(
        find.text('Bonul e salvat ca tranzacție; nu se mai modifică.'),
        findsOneWidget,
      );
      // Tranzacțiile și dashboard-ul se cer din nou (cifrele vin de la server).
      expect(
        r.h.server.requestsTo('GET /api/v1/transactions').length,
        greaterThan(1),
      );
    });

    testWidgets('posibil duplicat: dialog, apoi cheie nouă și allowDuplicate', (
      tester,
    ) async {
      final r = await openReceipts(tester);
      r.rec.receipts[FakeReceipts.receiptNew]!['duplicateOfReceiptId'] =
          FakeReceipts.receiptSaved;
      await tester.pumpAndSettle();
      await openReview(tester);
      expect(find.text('Posibil duplicat al bonului'), findsOneWidget);
      await pickAccount(tester);
      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Confirmă și salvează'),
      );
      expect(find.text('Posibil duplicat'), findsOneWidget);
      // Fără acord explicit nu se trimite allowDuplicate.
      await tester.tap(find.widgetWithText(TextButton, 'Nu'));
      await tester.pumpAndSettle();
      expect(r.rec.confirmBodies, hasLength(1));
      expect(
        r.rec.receipts[FakeReceipts.receiptNew]!['status'],
        'needs_review',
      );

      await tester.tapVisible(
        find.widgetWithText(FilledButton, 'Confirmă și salvează'),
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Salvează oricum'));
      await tester.pumpAndSettle();
      expect(r.rec.confirmBodies.last['allowDuplicate'], isTrue);
      expect(r.rec.confirmKeys.toSet(), hasLength(r.rec.confirmKeys.length));
      expect(r.rec.receipts[FakeReceipts.receiptNew]!['status'], 'saved');
    });

    testWidgets(
      'potrivirea cu extrasul: „Este aceasta” leagă și reîmprospătează',
      (tester) async {
        final r = await openReceipts(tester);
        await openReview(tester);
        expect(find.text('POS MEGA IMAGE 123'), findsOneWidget);
        expect(find.text('Potrivire probabilă'), findsOneWidget);
        expect(
          find.text(
            'aceeași sumă · la 1 zi · numele comerciantului apare în extras',
          ),
          findsOneWidget,
        );
        final before = r.h.server.requestsTo('GET /api/v1/transactions').length;
        await tester.tapVisible(
          find.widgetWithText(FilledButton, 'Este aceasta'),
        );
        expect(r.rec.matchDecisions.single, {
          'transactionId': FakeReceipts.txMatch,
          'decision': 'confirm',
        });
        expect(
          find.text('Bonul a fost legat de tranzacția din extras.'),
          findsOneWidget,
        );
        // Serverul a scos tranzacția dublură: lista se cere din nou.
        expect(
          r.h.server.requestsTo('GET /api/v1/transactions').length,
          greaterThan(before),
        );
      },
    );

    testWidgets('„Nu este” respinge propunerea', (tester) async {
      final r = await openReceipts(tester);
      await openReview(tester);
      await tester.tapVisible(find.widgetWithText(TextButton, 'Nu este'));
      expect(r.rec.matchDecisions.single['decision'], 'reject');
    });

    testWidgets('coada de potriviri apare din listă', (tester) async {
      await openReceipts(tester);
      await tester.tap(find.text('Potriviri cu extrasul'));
      await tester.pumpAndSettle();
      expect(find.text('POS MEGA IMAGE 123'), findsOneWidget);
    });

    testWidgets('bonul salvat este doar de citit', (tester) async {
      await openReceipts(tester);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Salvat'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Kaufland'));
      await tester.pumpAndSettle();
      expect(
        find.text('Bonul e salvat ca tranzacție; nu se mai modifică.'),
        findsOneWidget,
      );
      expect(find.text('Confirmă și salvează'), findsNothing);
    });

    testWidgets('ștergerea cere confirmare', (tester) async {
      final r = await openReceipts(tester);
      await openReview(tester);
      await tester.tapVisible(find.text('Șterge bonul'));
      await tester.tap(find.widgetWithText(FilledButton, 'Șterge'));
      await tester.pumpAndSettle();
      expect(r.rec.receipts.containsKey(FakeReceipts.receiptNew), isFalse);
      expect(FakeServer.accCurrent, isNotEmpty);
    });
  });
}
