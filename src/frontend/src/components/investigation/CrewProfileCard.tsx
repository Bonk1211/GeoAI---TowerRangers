import type { Crew, ScheduleEntry } from '../../api/types';
import { Panel } from '../ui/Panel';
import { EquipmentIcon } from '../shell/icons';

interface Props {
    crew?: Crew;
    entry?: ScheduleEntry;
}

export function CrewProfileCard({ crew, entry }: Props) {
    if (!crew) {
        return (
            <Panel title="Crew & Dispatch Team">
                <div className="rounded border border-watch/30 bg-watch/10 p-3 text-watch-ink/90 text-body">
                    Backlog — no crew assigned in current cycle
                </div>
            </Panel>
        );
    }

    // Generate initials from members array
    const members = crew.members || [];

    return (
        <Panel title="Crew & Dispatch Team">
            <div className="flex border-l-4 border-ok bg-overlay/[0.02] rounded-r p-4 gap-4">
                <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-2">
                        <span className="text-dim" aria-hidden="true"><EquipmentIcon /></span>
                        <h4 className="font-bold text-fg text-lead">{crew.name} ({crew.crew_id})</h4>
                    </div>

                    <div className="flex items-center gap-2 text-ui">
                        <span className="bg-overlay/10 px-2 py-0.5 rounded text-fg/80">{crew.crew_type}</span>
                        <span className="bg-overlay/10 px-2 py-0.5 rounded text-fg/80">{crew.territory}</span>
                        <span className="bg-overlay/10 px-2 py-0.5 rounded text-fg/80">≤{crew.max_travel_km} km</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div>
                            <div className="text-eyebrow uppercase text-dim tracking-wider mb-1">Members</div>
                            <div className="flex items-center gap-3">
                                {members.map(m => {
                                    const initials = m.split(' ').map(n => n[0]).join('').substring(0, 2);
                                    return (
                                        <div key={m} className="flex items-center gap-1.5">
                                            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-accent/20 border border-accent/30 text-eyebrow font-bold text-accent">
                                                {initials}
                                            </span>
                                            <span className="text-ui text-fg/90">{m}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                        <div>
                            <div className="text-eyebrow uppercase text-dim tracking-wider mb-1">Assignment Info</div>
                            <div className="text-ui text-fg/90">
                                Assigned: {entry ? new Date(entry.day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' }) : 'Pending'}
                                <br />
                                <span className="text-dim">Est. travel: ~18 km</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Panel>
    );
}
