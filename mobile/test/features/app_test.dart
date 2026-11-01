import 'package:finet_mobile/core/widgets/amount_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

const nbsp = ' ';

void main() {
  testWidgets('pornește pe Acasă, cu cele 5 taburi', (tester) async {
    final h = Harness()..signedInStore();
    await h.pump(tester);
    expect(find.text('Sold net (RON)'), findsOneWidget);
    for (final label in [
      'Acasă',
      'Tranzacții',
      'Scanează',
      'Rapoarte',
      'Mai mult',
    ]) {
      expect(
        find.widgetWithText(NavigationDestination, label),
        findsOneWidget,
        reason: label,
      );
    }
  });

  testWidgets('Acasă afișează exact cifrele serverului, formatate românește', (
    tester,
  ) async {
    final h = Harness()..signedInStore();
    await h.pump(tester);
    // Sold net 267655 → 2.676,55 lei; venituri 7.800,00; cheltuieli -5.123,45.
    expect(find.text('2.676,55${nbsp}lei'), findsOneWidget);
    expect(find.text('7.800,00${nbsp}lei'), findsOneWidget);
    expect(find.text('-5.123,45${nbsp}lei'), findsOneWidget);
    expect(find.text('37 tranzacții în această lună'), findsOneWidget);
    // Comparația cu luna trecută vine de la server (nu se recalculează).
    expect(find.text('+11%'), findsOneWidget);
    expect(find.text('-15%'), findsOneWidget);
    expect(find.text('Alimente'), findsOneWidget);
    // Conturi și total (de la `GET /accounts`).
    await tester.scrollUntilVisible(find.text('Total RON'), 300);
    expect(find.text('Cont curent'), findsOneWidget);
    expect(find.text('1.234,56${nbsp}lei'), findsOneWidget);
    expect(find.text('1.284,56${nbsp}lei'), findsOneWidget);
  });

  testWidgets('navigarea de jos schimbă ecranele', (tester) async {
    final h = Harness()..signedInStore();
    await h.pump(tester);

    await tester.openTab('Tranzacții');
    expect(find.text('Cumpărături săptămânale'), findsOneWidget);
    expect(find.text('Adaugă'), findsOneWidget);

    await tester.openTab('Scanează');
    expect(find.text('Fotografiază bonul'), findsOneWidget);

    await tester.openTab('Rapoarte');
    expect(find.textContaining('Raport lunar'), findsOneWidget);

    await tester.openTab('Mai mult');
    expect(find.text('Profil și gospodării'), findsOneWidget);
    expect(find.text('Bugete și obiective'), findsOneWidget);
    expect(find.text('Setări și confidențialitate'), findsOneWidget);

    await tester.openTab('Acasă');
    expect(find.text('Sold net (RON)'), findsOneWidget);
  });

  testWidgets('comutatorul „Ascunde sumele” înlocuiește sumele cu ••••', (
    tester,
  ) async {
    final h = Harness()..signedInStore();
    await h.pump(tester);
    expect(find.textContaining('lei'), findsWidgets);
    expect(find.text(hiddenAmount), findsNothing);

    await tester.tap(find.byTooltip('Ascunde sumele'));
    await tester.pumpAndSettle();
    expect(find.textContaining('lei'), findsNothing);
    expect(find.text(hiddenAmount), findsWidgets);

    await tester.tap(find.byTooltip('Arată sumele'));
    await tester.pumpAndSettle();
    expect(find.textContaining('lei'), findsWidgets);
  });

  testWidgets('tema întunecată se construiește fără erori', (tester) async {
    tester.platformDispatcher.platformBrightnessTestValue = Brightness.dark;
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);
    final h = Harness()..signedInStore();
    await h.pump(tester);
    expect(find.text('Sold net (RON)'), findsOneWidget);
  });

  testWidgets('luna aleasă ajunge la server; nu se trece de luna curentă', (
    tester,
  ) async {
    final h = Harness(clock: () => DateTime.utc(2026, 11, 1, 10))
      ..signedInStore();
    await h.pump(tester);
    expect(h.server.dashboardMonths.last, '2026-11');

    // Luna curentă: „următoarea” e dezactivată.
    final next = find.widgetWithIcon(IconButton, Icons.chevron_right);
    expect(tester.widget<IconButton>(next).onPressed, isNull);

    await tester.tap(find.byTooltip('Luna anterioară'));
    await tester.pumpAndSettle();
    expect(find.text('Octombrie 2026'), findsOneWidget);
    expect(h.server.dashboardMonths.last, '2026-10');
    expect(tester.widget<IconButton>(next).onPressed, isNotNull);
  });
}
