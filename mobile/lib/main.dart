import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/config/env.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final env = AppEnv.fromEnvironment();
  final problems = env.validate(isRelease: kReleaseMode);
  if (problems.isNotEmpty) {
    runApp(_ConfigError(problems: problems));
    return;
  }
  runApp(const ProviderScope(child: FinetApp()));
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
