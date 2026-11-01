import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/client/client_info.dart';
import 'core/config/env.dart';
import 'core/providers.dart';
import 'core/storage/key_value_store.dart';
import 'core/time/period.dart';
import 'features/settings/app_settings.dart';
import 'features/update/update_controller.dart';
import 'features/settings/settings_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  initTimezones();
  final env = AppEnv.fromEnvironment();
  final problems = env.validate(isRelease: kReleaseMode);
  if (problems.isNotEmpty) {
    runApp(_ConfigError(problems: problems));
    return;
  }
  final store = SecureKeyValueStore();
  final info = await loadClientInfo(store);
  final settings = await AppSettings.load(
    store,
    usageStatsDefault: env.usageStatsDefault,
  );
  final cachedUpdate = await loadCachedUpdate(store);
  runApp(
    ProviderScope(
      overrides: [
        initialUpdateProvider.overrideWithValue(cachedUpdate),
        appEnvProvider.overrideWithValue(env),
        keyValueStoreProvider.overrideWithValue(store),
        clientInfoProvider.overrideWithValue(info),
        initialSettingsProvider.overrideWithValue(settings),
      ],
      child: const FinetApp(),
    ),
  );
}

/// Configurare greșită la build: aplicația nu pornește „pe jumătate”, afișează motivul.
class _ConfigError extends StatelessWidget {
  const _ConfigError({required this.problems});
  final List<String> problems;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Configurare invalidă',
                  style: TextStyle(fontSize: 22),
                ),
                const SizedBox(height: 12),
                for (final p in problems) Text('• $p'),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
