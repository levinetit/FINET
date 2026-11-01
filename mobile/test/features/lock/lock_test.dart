import 'package:finet_mobile/core/storage/key_value_store.dart';
import 'package:finet_mobile/features/settings/app_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../support/harness.dart';

const locked = AppSettings(introSeen: true, usageStats: false, appLock: true);

void main() {
  testWidgets('pornește blocată; deblocarea reușită arată conținutul', (
    tester,
  ) async {
    final auth = FakeAuthenticator()..succeeds = false;
    final h = Harness(settings: locked, authenticator: auth)..signedInStore();
    await h.pump(tester);

    expect(find.text('Aplicația este blocată'), findsOneWidget);
    // Conținutul nu e desenat și nu e expus accesibilității cât timp e blocat.
    expect(find.text('Sold net (RON)'), findsNothing);
    expect(auth.prompts, 1);

    auth.succeeds = true;
    await tester.tap(find.text('Deblochează'));
    await tester.pumpAndSettle();
    expect(find.text('Aplicația este blocată'), findsNothing);
    expect(find.text('Sold net (RON)'), findsOneWidget);
  });

  testWidgets('fără blocare activată nu cere nimic', (tester) async {
    final auth = FakeAuthenticator();
    final h = Harness(authenticator: auth)..signedInStore();
    await h.pump(tester);
    expect(find.text('Aplicația este blocată'), findsNothing);
    expect(auth.prompts, 0);
  });

  testWidgets('după 2 minute în fundal se blochează din nou; mai puțin, nu', (
    tester,
  ) async {
    var now = DateTime(2026, 11, 1, 10);
    final auth = FakeAuthenticator();
    final h = Harness(settings: locked, authenticator: auth, clock: () => now)
      ..signedInStore();
    await h.pump(tester);
    expect(find.text('Sold net (RON)'), findsOneWidget);
    expect(auth.prompts, 1);

    // 30 de secunde în fundal: rămâne deblocată.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    now = now.add(const Duration(seconds: 30));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(auth.prompts, 1);
    expect(find.text('Sold net (RON)'), findsOneWidget);

    // 3 minute în fundal: se blochează și cere autentificarea.
    auth.succeeds = false;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    now = now.add(const Duration(minutes: 3));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(auth.prompts, 2);
    expect(find.text('Aplicația este blocată'), findsOneWidget);
    expect(find.text('Sold net (RON)'), findsNothing);
  });

  group('comutatorul din Setări', () {
    Future<void> openSettings(WidgetTester tester) async {
      await tester.openTab('Mai mult');
      await tester.tap(find.text('Setări și confidențialitate'));
      await tester.pumpAndSettle();
    }

    testWidgets('pornirea cere o autentificare reușită', (tester) async {
      final auth = FakeAuthenticator();
      final h = Harness(authenticator: auth)..signedInStore();
      await h.pump(tester);
      await openSettings(tester);
      await tester.tap(
        find.widgetWithText(SwitchListTile, 'Blochează aplicația'),
      );
      await tester.pumpAndSettle();
      expect(auth.prompts, 1);
      expect(h.memory.values[StoreKeys.appLock], '1');
    });

    testWidgets('autentificare eșuată: blocarea nu se activează', (
      tester,
    ) async {
      final auth = FakeAuthenticator()..succeeds = false;
      final h = Harness(authenticator: auth)..signedInStore();
      await h.pump(tester);
      await openSettings(tester);
      await tester.tap(
        find.widgetWithText(SwitchListTile, 'Blochează aplicația'),
      );
      await tester.pumpAndSettle();
      expect(h.memory.values.containsKey(StoreKeys.appLock), isFalse);
    });

    testWidgets('telefon fără blocare de ecran: mesaj, nu se activează', (
      tester,
    ) async {
      final auth = FakeAuthenticator()..supported = false;
      final h = Harness(authenticator: auth)..signedInStore();
      await h.pump(tester);
      await openSettings(tester);
      await tester.tap(
        find.widgetWithText(SwitchListTile, 'Blochează aplicația'),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('nu are blocare de ecran'), findsOneWidget);
      expect(auth.prompts, 0);
      expect(h.memory.values.containsKey(StoreKeys.appLock), isFalse);
    });
  });
}
