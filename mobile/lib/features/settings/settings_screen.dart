import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../lock/app_lock.dart';
import '../usage/usage_tracker.dart';
import 'settings_controller.dart';

/// Setări: confidențialitate (statistici de utilizare), blocarea aplicației și informații.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);
    final info = ref.watch(clientInfoProvider);
    final text = Theme.of(context).textTheme;
    final muted = text.bodySmall?.copyWith(color: context.finet.muted);
    return FinetScaffold(
      title: 'Setări',
      mock: false,
      screen: UsageScreens.settings,
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Confidențialitate', style: text.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                SwitchListTile(
                  title: const Text('Trimite statistici de utilizare'),
                  subtitle: const Text(
                    'Ecrane și funcții folosite, fără sume sau alte date financiare. '
                    'Versiunea aplicației se trimite oricum, pentru compatibilitate și '
                    'pentru notificarea de actualizare.',
                  ),
                  value: settings.usageStats,
                  onChanged: (v) => ref
                      .read(settingsProvider.notifier)
                      .setUsageStats(enabled: v),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Text('Securitate', style: text.titleMedium),
          const SizedBox(height: 8),
          Card(
            child: SwitchListTile(
              title: const Text('Blochează aplicația'),
              subtitle: const Text(
                'Cere amprenta, fața sau PIN-ul telefonului la deschidere și după 2 minute '
                'în fundal.',
              ),
              value: settings.appLock,
              onChanged: (v) => _toggleLock(context, ref, enabled: v),
            ),
          ),
          const SizedBox(height: 24),
          Center(
            child: Text(
              'FINET Android ${info.versionName} (${info.versionCode})',
              style: muted,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _toggleLock(
    BuildContext context,
    WidgetRef ref, {
    required bool enabled,
  }) async {
    final messenger = ScaffoldMessenger.of(context);
    final controller = ref.read(settingsProvider.notifier);
    if (!enabled) {
      await controller.setAppLock(enabled: false);
      return;
    }
    // Pornirea cere o autentificare reușită: altfel utilizatorul s-ar putea bloca afară.
    final auth = ref.read(authenticatorProvider);
    if (!await auth.isSupported()) {
      messenger.showSnackBar(
        const SnackBar(
          content: Text(
            'Telefonul nu are blocare de ecran. Setează un PIN sau o amprentă.',
          ),
        ),
      );
      return;
    }
    if (await auth.authenticate(
      'Confirmă ca să activezi blocarea aplicației',
    )) {
      await controller.setAppLock(enabled: true);
    }
  }
}
