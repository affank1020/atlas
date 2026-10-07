import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native modal containment supplies keyboard focus trapping and Escape dismissal. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
    const ref = useRef<HTMLDialogElement>(null);
    const label = useId();
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        ref.current?.showModal();
        return () => { ref.current?.close(); previous?.focus(); };
    }, []);
    return <dialog ref={ref} className="modal" aria-labelledby={label} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}><header><h2 id={label}>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">×</button></header>{children}</dialog>;
}
