import 'package:flutter/material.dart';

import '../update/update_widgets.dart';

import 'package:go_router/go_router.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';

/// Mai mult: intrările către restul aplicației. În Faza A doar structura; fiecare intrare spune
/// în ce fază apare.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  static const _soon = <_Soon>[
    _Soon(Icons.family_restroom_outlined, 'Familie', 'după MVP'),
  ];

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return FinetScaffold(
      title: 'Mai mult',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const UpdateBanner(),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: Icon(
                    Icons.person_outline,
                    color: context.finet.muted,
                  ),
                  title: const Text('Profil și gospodării'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/profile'),
                ),
                const Divider(),
                ListTile(
                  leading: Icon(
                    Icons.settings_outlined,
                    color: context.finet.muted,
                  ),
                  title: const Text('Setări și confidențialitate'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/settings'),
                ),
                const Divider(),
                ListTile(
                  leading: Icon(
                    Icons.savings_outlined,
                    color: context.finet.muted,
                  ),
                  title: const Text('Bugete și obiective'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/budgets'),
                ),
                const Divider(),
                ListTile(
                  leading: Icon(Icons.repeat, color: context.finet.muted),
                  title: const Text('Plăți recurente'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/recurring'),
                ),
                const Divider(),
                ListTile(
                  leading: Icon(
                    Icons.receipt_long_outlined,
                    color: context.finet.muted,
                  ),
                  title: const Text('Bonuri'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/receipts'),
                ),
                const Divider(),
                ListTile(
                  leading: Icon(
                    Icons.account_balance_outlined,
                    color: context.finet.muted,
                  ),
                  title: const Text('Extrase bancare'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push('/statements'),
                ),
                for (final e in _soon) ...[
                  const Divider(),
                  ListTile(
                    leading: Icon(e.icon, color: context.finet.muted),
                    title: Text(e.title),
                    subtitle: Text('Disponibil în ${e.phase}'),
                    enabled: false,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 24),
          Center(
            child: Text(
              'FINET Android',
              style: text.bodySmall?.copyWith(color: context.finet.muted),
            ),
          ),
        ],
      ),
    );
  }
}

class _Soon {
  const _Soon(this.icon, this.title, this.phase);
  final IconData icon;
  final String title;
  final String phase;
}
