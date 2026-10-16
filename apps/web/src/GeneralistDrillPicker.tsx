import { useMemo, useState } from 'react';
import type { GeneralistScenario } from './FootballGeneralistDashboard';
import { groupLabel, scenarioPurpose, skillForScenario, SKILL_GROUPS, SHOWCASE_DRILL } from './football-skill-model';

type Mode = 'train' | 'evaluate' | 'watch';
export function GeneralistDrillPicker({ scenarios, mode, value, onChange }: {
    scenarios: GeneralistScenario[]; mode: Mode; value: string; onChange: (id: string) => void;
}) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const entries = useMemo(() => [
        ...(mode === 'watch' ? [{ id: SHOWCASE_DRILL, name: 'Mixed dribbling showcase · random', skill: 'dribbling', purpose: 'showcase' }] : []),
        { id: 'mix', name: 'S0 mixed contact starts', skill: 'contact', purpose: 'training' },
        ...(mode === 'train' ? [{ id: 's1_rehearsal', name: 'S1 with S0 rehearsal', skill: 'dribbling', purpose: 'training' }] : []),
        ...scenarios.map(s => ({ id: s.id, name: s.name, skill: skillForScenario(s), purpose: scenarioPurpose(s.id) })),
    ], [mode, scenarios]);
    const selected = entries.find(item => item.id === value);
    return <div className="fg-drill-picker">
        <label className="fg-picker-caption">Choose drill</label>
        <button type="button" className="fg-picker-trigger" aria-expanded={open}
            onClick={() => setOpen(v => !v)}>
            <span>{selected?.name ?? 'Select a drill'}</span><span aria-hidden="true">⌄</span>
        </button>
        {open && <div className="fg-picker-menu">
            <input type="search" aria-label="Search drill picker" placeholder="Search drills…" value={query}
                onChange={e => setQuery(e.target.value)}/>
            {SKILL_GROUPS.map(g => {
                const members = entries.filter(e => e.skill === g.id &&
                    (e.name + ' ' + e.id + ' ' + e.purpose).toLowerCase().includes(query.toLowerCase()));
                return members.length ? <div key={g.id} className="fg-picker-group">
                    <strong>{groupLabel(g.id)}</strong>
                    {members.map(e => <button type="button" key={e.id}
                        aria-pressed={value === e.id}
                        className={value === e.id ? 'selected' : ''}
                        onClick={() => { onChange(e.id); setOpen(false); setQuery(''); }}>
                        <span>{e.name}</span><small>{e.purpose === 'benchmark-candidate' ? 'Benchmark candidate' : e.purpose === 'showcase' ? 'Demo' : 'Training'}</small>
                    </button>)}
                </div> : null;
            })}
            {entries.every(e => !(e.name + ' ' + e.id + ' ' + e.purpose).toLowerCase().includes(query.toLowerCase())) &&
                <p className="fg-muted">No matching drills</p>}
        </div>}
    </div>;
}
