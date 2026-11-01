import 'package:flutter/material.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';

/// Mai mult: intrările către restul aplicației. În Faza A doar structura; fiecare intrare spune
/// în ce fază apare.
class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key});

  static const _entries = <(IconData, String, String)>[
    (Icons.person_outline, 'Profil și gospodării', 'Faza B'),
    (Icons.savings_outlined, 'Bugete și obiective', 'Faza C'),
    (Icons.repeat, 'Recurențe', 'Faza D'),
    (Icons.receipt_long_outlined, 'Bonuri și extrase', 'Faza D'),
    (Icons.family_restroom_outlined, 'Familie', 'după MVP'),
    (Icons.settings_outlined, 'Setări și confidențialitate', 'Faza B'),
  ];

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return FinetScaffold(
      title: 'Mai mult',
      mock: false,
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: Column(
              children: [
                for (final (i, e) in _entries.indexed) ...[
                  ListTile(
                    leading: Icon(e.$1, color: context.finet.muted),
                    title: Text(e.$2),
                    subtitle: Text('Disponibil în ${e.$3}'),
                    enabled: false,
                  ),
                  if (i != _entries.length - 1) const Divider(),
                ],
              ],
            ),
          ),
          const SizedBox(height: 24),
          Center(
            child: Text(
              'FINET Android · versiunea de dezvoltare',
              style: text.bodySmall?.copyWith(color: context.finet.muted),
            ),
          ),
        ],
      ),
    );
  }
}
