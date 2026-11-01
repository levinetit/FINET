import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/fake_recurring.dart';
import '../../support/fake_server.dart';
import '../../support/harness.dart';

const nbsp = '\u00a0';

Future<FakeRecurring> openRecurring(WidgetTester tester, Harness h) async {
  final rec = FakeRecurring(h.server);
  await h.pump(tester);
  await tester.openTab('Mai mult');
  await tester.tapVisible(find.text('Plăți recurente'));
  return rec;
}

void main() {
  group('plăți recurente', () {
    testWidgets('lista arată regulile și contoarele calculate de server', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      await openRecurring(tester, h);
      expect(find.text('1 active · 1 scadente · 3 în total'), findsOneWidget);
      expect(find.text('Chirie'), findsOneWidget);
      expect(find.text('Sală'), findsOneWidget);
      expect(find.text('lunar · următoarea: 05.11.2026'), findsOneWidget);
      expect(
        find.text('la fiecare 2 luni · următoarea: 10.11.2026'),
        findsOneWidget,
      );
      expect(find.text('Scadentă'), findsOneWidget);
      expect(find.text('− 1.800,00${nbsp}lei'), findsOneWidget);
    });

    testWidgets('sumele ascunse nu apar nicăieri pe ecran', (tester) async {
      final h = Harness()..signedInStore();
      await openRecurring(tester, h);
      await tester.tap(find.byTooltip('Ascunde sumele'));
      await tester.pumpAndSettle();
      expect(find.textContaining('lei'), findsNothing);
      expect(find.textContaining('45,99'), findsNothing);
      expect(find.text('••••'), findsWidgets);
    });

    testWidgets('filtrul de stare arată doar regulile cerute', (tester) async {
      final h = Harness()..signedInStore();
      await openRecurring(tester, h);
      await tester.tap(find.widgetWithText(ChoiceChip, 'Pe pauză'));
      await tester.pumpAndSettle();
      expect(find.text('Sală'), findsOneWidget);
      expect(find.text('Chirie'), findsNothing);
    });

    testWidgets('pauză și reluare se aplică pe server', (tester) async {
      final h = Harness()..signedInStore();
      final rec = await openRecurring(tester, h);
      await tester.tap(find.widgetWithText(TextButton, 'Pauză'));
      await tester.pumpAndSettle();
      expect(
        rec.rules.firstWhere(
          (r) => r['id'] == FakeRecurring.ruleRent,
        )['status'],
        'paused',
      );
      expect(find.widgetWithText(TextButton, 'Reia'), findsNWidgets(2));
      await tester.tap(find.widgetWithText(TextButton, 'Reia').first);
      await tester.pumpAndSettle();
      expect(
        rec.rules.firstWhere(
          (r) => r['id'] == FakeRecurring.ruleRent,
        )['status'],
        'active',
      );
    });

    testWidgets('regula încheiată nu are buton de pauză', (tester) async {
      final h = Harness()..signedInStore();
      await openRecurring(tester, h);
      // 3 reguli, doar 2 pot fi puse pe pauză sau reluate.
      expect(find.text('Pauză'), findsOneWidget);
      expect(find.text('Reia'), findsOneWidget);
      expect(find.text('Încheiată'), findsWidgets);
    });

    testWidgets('serverul poate refuza pauza (409) și mesajul apare', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      final rec = await openRecurring(tester, h);
      // Starea s-a schimbat între timp pe server.
      rec.rules.firstWhere((r) => r['id'] == FakeRecurring.ruleRent)['status'] =
          'completed';
      await tester.tap(find.widgetWithText(TextButton, 'Pauză'));
      await tester.pumpAndSettle();
      expect(
        find.text('Regula este încheiată și nu poate fi modificată.'),
        findsOneWidget,
      );
    });

    testWidgets(
      '„Generează acum” trimite cheie de idempotență și arată rezultatul',
      (tester) async {
        final h = Harness()..signedInStore();
        final rec = await openRecurring(tester, h);
        await tester.tap(find.widgetWithText(FilledButton, 'Generează acum'));
        await tester.pumpAndSettle();
        expect(rec.generateKeys, hasLength(1));
        expect(rec.generatedTransactions, 2);
        expect(find.text('Generate: 2. Eșuate: 0. Sărite: 0.'), findsOneWidget);
        // O a doua apăsare e o acțiune nouă, cu altă cheie.
        await tester.tap(find.widgetWithText(FilledButton, 'Generează acum'));
        await tester.pumpAndSettle();
        expect(rec.generateKeys.toSet(), hasLength(2));
      },
    );

    testWidgets('propunerea se acceptă cu cheie și dispare', (tester) async {
      final h = Harness()..signedInStore();
      final rec = await openRecurring(tester, h);
      expect(find.text('StreamCo'), findsOneWidget);
      await tester.tapVisible(find.widgetWithText(FilledButton, 'Acceptă'));
      expect(rec.accepted, ['sig/abc 1']);
      expect(rec.acceptKeys.single, isNotEmpty);
      expect(find.text('StreamCo'), findsNothing);
    });

    testWidgets('propunerea se poate respinge', (tester) async {
      final h = Harness()..signedInStore();
      final rec = await openRecurring(tester, h);
      await tester.tapVisible(find.widgetWithText(TextButton, 'Respinge'));
      expect(rec.dismissed, ['sig/abc 1']);
      expect(find.text('StreamCo'), findsNothing);
    });

    testWidgets('fără rețea: eroare cu reîncercare, fără date inventate', (
      tester,
    ) async {
      final h = Harness()..signedInStore();
      FakeRecurring(h.server);
      await h.pump(tester);
      await tester.openTab('Mai mult');
      h.server.offline = true;
      await tester.tapVisible(find.text('Plăți recurente'));
      expect(find.text('Încearcă din nou'), findsOneWidget);
      expect(find.text('Chirie'), findsNothing);
      expect(FakeServer.accCurrent, isNotEmpty);
    });
  });
}
