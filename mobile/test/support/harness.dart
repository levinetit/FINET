import 'dart:async';

import 'package:finet_mobile/app.dart';
import 'package:finet_mobile/core/client/client_info.dart';
import 'package:finet_mobile/core/config/env.dart';
import 'package:finet_mobile/core/providers.dart';
import 'package:finet_mobile/core/storage/key_value_store.dart';
import 'package:finet_mobile/features/lock/app_lock.dart';
import 'package:finet_mobile/features/lock/authenticator.dart';
import 'package:finet_mobile/features/settings/app_settings.dart';
import 'package:finet_mobile/features/settings/settings_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_server.dart';

const testClientInfo = ClientInfo(
  installationId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  versionName: '0.2.0',
  versionCode: 2,
  osVersion: '14',
  model: 'Google Pixel 8',
);

class FakeAuthenticator implements Authenticator {
  bool supported = true;
  bool succeeds = true;
  int prompts = 0;

  @override
  Future<bool> isSupported() async => supported;

  @override
  Future<bool> authenticate(String reason) async {
    prompts++;
    return succeeds;
  }
}

/// Tot ce un test trebuie să atingă după ce a pornit aplicația.
class Harness {
  Harness({
    FakeServer? server,
    KeyValueStore? store,
    AppSettings? settings,
    FakeAuthenticator? authenticator,
    DateTime Function()? clock,
  }) : server = server ?? FakeServer(),
       store = store ?? MemoryKeyValueStore(),
       settings =
           settings ??
           const AppSettings(introSeen: true, usageStats: true, appLock: false),
       authenticator = authenticator ?? FakeAuthenticator(),
       clock = clock ?? DateTime.now;

  final FakeServer server;
  final KeyValueStore store;
  final AppSettings settings;
  final FakeAuthenticator authenticator;
  final DateTime Function() clock;

  MemoryKeyValueStore get memory => store as MemoryKeyValueStore;

  late final ProviderContainer container;

  Future<void> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);
    final scope = ProviderScope(
      overrides: [
        appEnvProvider.overrideWithValue(
          const AppEnv(
            apiBaseUrl: 'https://finet.exemplu.test',
            useMockData: true,
          ),
        ),
        keyValueStoreProvider.overrideWithValue(store),
        clientInfoProvider.overrideWithValue(testClientInfo),
        initialSettingsProvider.overrideWithValue(settings),
        httpAdapterProvider.overrideWithValue(server),
        authenticatorProvider.overrideWithValue(authenticator),
        clockProvider.overrideWithValue(clock),
      ],
      child: const FinetApp(),
    );
    await tester.pumpWidget(scope);
    container = ProviderScope.containerOf(
      tester.element(find.byType(FinetApp)),
    );
    await tester.pumpAndSettle();
  }

  /// Trimite coada de evenimente. Testul rulează într-o zonă cu timp simulat, deci nu se poate
  /// aștepta direct rezultatul unei cereri: se pornește și se avansează timpul.
  Future<void> flushEvents(WidgetTester tester) async {
    unawaited(container.read(usageTrackerProvider).flush());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pumpAndSettle();
  }

  /// Pune tokenul valid în stocare, ca la o aplicație deja autentificată.
  void signedInStore() =>
      memory.values[StoreKeys.sessionToken] = FakeServer.token;
}

extension HarnessActions on WidgetTester {
  Future<void> login({
    String email = FakeServer.email,
    String password = FakeServer.password,
  }) async {
    await enterText(find.widgetWithText(TextFormField, 'Email'), email);
    await enterText(find.widgetWithText(TextFormField, 'Parola'), password);
    await tap(find.widgetWithText(FilledButton, 'Autentifică-te'));
    await pumpAndSettle();
  }

  /// Derulează până la element (ecranul de test e mic), apoi apasă și așteaptă să se liniștească.
  Future<void> tapVisible(Finder finder) async {
    await ensureVisible(finder);
    await pumpAndSettle();
    await tap(finder);
    await pumpAndSettle();
  }

  Future<void> openTab(String label) async {
    await tap(find.widgetWithText(NavigationDestination, label));
    await pumpAndSettle();
  }
}
