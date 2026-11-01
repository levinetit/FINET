import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/logo.dart';
import '../settings/settings_controller.dart';
import '../usage/usage_tracker.dart';

/// Ecranul de informare de la prima pornire (promptul Android §10.1): ce se colectează și ce nu,
/// cu alegerea pentru statisticile de utilizare.
class IntroScreen extends ConsumerStatefulWidget {
  const IntroScreen({super.key});

  @override
  ConsumerState<IntroScreen> createState() => _IntroScreenState();
}

class _IntroScreenState extends ConsumerState<IntroScreen> {
  late bool _usageStats = ref.read(settingsProvider).usageStats;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    ref.read(usageTrackerProvider).screen(UsageScreens.onboarding);
  }

  Future<void> _continue() async {
    setState(() => _busy = true);
    await ref
        .read(settingsProvider.notifier)
        .completeIntro(usageStats: _usageStats);
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final muted = text.bodyMedium?.copyWith(color: context.finet.muted);
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Center(child: FinetLogo(height: 44)),
              const SizedBox(height: 28),
              Text('Înainte să începi', style: text.headlineSmall),
              const SizedBox(height: 12),
              Text(
                'Aplicația trimite administratorului FINET câteva informații tehnice, ca să știe '
                'cine trebuie să actualizeze și unde apar probleme.',
                style: text.bodyMedium,
              ),
              const SizedBox(height: 16),
              Text('Ce se colectează', style: text.titleSmall),
              const SizedBox(height: 4),
              Text(
                '• versiunea aplicației și a Android-ului, modelul telefonului și limba;\n'
                '• un identificator aleator al instalării (nu al telefonului);\n'
                '• ce ecrane și funcții folosești (de exemplu „Rapoarte”), când și cât de des;\n'
                '• codul unei erori, fără text.',
                style: muted,
              ),
              const SizedBox(height: 12),
              Text('Ce nu se colectează niciodată', style: text.titleSmall),
              const SizedBox(height: 4),
              Text(
                'Sume, descrieri, comercianți, categorii, conținutul bonurilor, căutări, locația '
                'sau lista de contacte. Nu folosim servicii externe de statistici.',
                style: muted,
              ),
              const SizedBox(height: 16),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Trimite statistici de utilizare'),
                subtitle: const Text(
                  'Poți schimba oricând din Setări. Versiunea aplicației se trimite oricum, '
                  'pentru compatibilitate și pentru notificarea de actualizare.',
                ),
                value: _usageStats,
                onChanged: _busy
                    ? null
                    : (v) => setState(() => _usageStats = v),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: _busy ? null : _continue,
                child: const Text('Am înțeles'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
