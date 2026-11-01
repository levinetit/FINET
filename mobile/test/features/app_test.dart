import 'package:finet_mobile/core/widgets/amount_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

void main() {
  testWidgets('pornește pe Acasă, cu banda „Date simulate” și cele 5 taburi', (
    tester,
  ) async {
    final h = Harness()..signedInStore();
    await h.pump(tester);
    expect(find.text('Date simulate'), findsOneWidget);
    expect(find.text('Sold net'), findsOneWidget);
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

  testWidgets('navigarea de jos schimbă ecranele', (tester) async {
    final h = Harness()..signedInStore();
    await h.pump(tester);

    await tester.openTab('Tranzacții');
    expect(find.text('Cumpărături săptămânale'), findsOneWidget);
    expect(find.text('Adaugă'), findsOneWidget);

    await tester.openTab('Scanează');
    expect(find.text('Scanarea bonurilor vine în curând'), findsOneWidget);
    // Ecranul Scanează nu afișează date, deci nu poartă eticheta „Date simulate”.
    expect(find.text('Date simulate'), findsNothing);

    await tester.openTab('Rapoarte');
    expect(find.text('Raport lunar'), findsOneWidget);

    await tester.openTab('Mai mult');
    expect(find.text('Profil și gospodării'), findsOneWidget);
    expect(find.text('Setări și confidențialitate'), findsOneWidget);

    await tester.openTab('Acasă');
    expect(find.text('Sold net'), findsOneWidget);
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
    expect(find.text('Sold net'), findsOneWidget);
  });
}
