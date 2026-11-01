import 'package:finet_mobile/app.dart';
import 'package:finet_mobile/core/widgets/amount_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> pumpApp(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(const ProviderScope(child: FinetApp()));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('pornește pe Acasă, cu banda „Date simulate” și cele 5 taburi', (
    tester,
  ) async {
    await pumpApp(tester);
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
    await pumpApp(tester);

    await tester.tap(find.widgetWithText(NavigationDestination, 'Tranzacții'));
    await tester.pumpAndSettle();
    expect(find.text('Cumpărături săptămânale'), findsOneWidget);
    expect(find.text('Adaugă'), findsOneWidget);

    await tester.tap(find.widgetWithText(NavigationDestination, 'Scanează'));
    await tester.pumpAndSettle();
    expect(find.text('Scanarea bonurilor vine în curând'), findsOneWidget);
    // Ecranul Scanează nu afișează date, deci nu poartă eticheta „Date simulate”.
    expect(find.text('Date simulate'), findsNothing);

    await tester.tap(find.widgetWithText(NavigationDestination, 'Rapoarte'));
    await tester.pumpAndSettle();
    expect(find.text('Raport lunar'), findsOneWidget);

    await tester.tap(find.widgetWithText(NavigationDestination, 'Mai mult'));
    await tester.pumpAndSettle();
    expect(find.text('Profil și gospodării'), findsOneWidget);

    await tester.tap(find.widgetWithText(NavigationDestination, 'Acasă'));
    await tester.pumpAndSettle();
    expect(find.text('Sold net'), findsOneWidget);
  });

  testWidgets('comutatorul „Ascunde sumele” înlocuiește sumele cu ••••', (
    tester,
  ) async {
    await pumpApp(tester);
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
    await pumpApp(tester);
    expect(find.text('Sold net'), findsOneWidget);
  });
}
