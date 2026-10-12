'use client';
import { useEffect, useState } from 'react';
import { LuCircleAlert, LuCircleCheck, LuSave, LuX } from 'react-icons/lu';
import { isTechnicianCategory, technicianCategories } from '@/lib/categories';
import type { TechnicianCategory } from '@/lib/categories';
import type { TechnicianProfileEdit } from '@/lib/types';
import { readPersisted, writePersisted } from '@/lib/mocks/persistence';

type SaveState = 'idle' | 'saved' | 'quota' | 'failed';

interface ProfileEditorProps {
  /** Stable mock-record name used as the persistence key (not editable). */
  profileKey: string;
  displayName: string;
  category: TechnicianCategory;
  skills: string[];
  availability: string;
}

function profileStorageKey(profileKey: string): string {
  return `umodzi:profile:${profileKey}`;
}

function parseSkills(raw: string): string[] {
  return raw
    .split(',')
    .map((skill) => skill.trim())
    .filter((skill) => skill.length > 0);
}

/**
 * Prototype profile editor (V0.2).
 *
 * Edits the fields already present on the Technician type: display name,
 * category, skills, availability and service notes. Persists to localStorage
 * via the typed mock persistence layer: edits survive page refresh, work
 * offline, require no backend, are hydration-safe, and degrade to in-memory
 * state (with a visible notice) when storage is unavailable or the quota is
 * exceeded. The original mock record is never mutated.
 */
export default function ProfileEditor({
  profileKey,
  displayName,
  category,
  skills,
  availability,
}: ProfileEditorProps) {
  const [name, setName] = useState(displayName);
  const [categoryValue, setCategoryValue] = useState<TechnicianCategory>(category);
  const [skillsValue, setSkillsValue] = useState(skills.join(', '));
  const [availabilityValue, setAvailabilityValue] = useState(availability);
  const [notes, setNotes] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [validationError, setValidationError] = useState('');

  const storageKey = profileStorageKey(profileKey);

  // Hydration-safe: read persisted edits only after mount.
  useEffect(() => {
    const persisted = readPersisted<TechnicianProfileEdit>(storageKey, {});
    if (persisted.name !== undefined) setName(persisted.name);
    if (persisted.category !== undefined) setCategoryValue(persisted.category);
    if (persisted.skills !== undefined) setSkillsValue(persisted.skills.join(', '));
    if (persisted.availability !== undefined) setAvailabilityValue(persisted.availability);
    if (persisted.notes !== undefined) setNotes(persisted.notes);
  }, [storageKey]);

  const validate = (): string => {
    if (name.trim().length === 0) return 'Display name is required.';
    if (!isTechnicianCategory(categoryValue)) return 'Please choose a valid service category.';
    if (parseSkills(skillsValue).length === 0) return 'Add at least one skill.';
    if (availabilityValue.trim().length === 0) return 'Availability status is required.';
    return '';
  };

  const handleSave = () => {
    const error = validate();
    if (error) {
      setValidationError(error);
      setSaveState('idle');
      return;
    }
    setValidationError('');
    const edit: TechnicianProfileEdit = {
      name: name.trim(),
      category: categoryValue,
      skills: parseSkills(skillsValue),
      availability: availabilityValue.trim(),
      notes: notes.trim(),
    };
    const result = writePersisted(storageKey, edit);
    if (result.ok) {
      setSaveState('saved');
    } else if (result.reason === 'quota') {
      setSaveState('quota');
    } else {
      setSaveState('failed');
    }
  };

  const handleCancel = () => {
    const persisted = readPersisted<TechnicianProfileEdit>(storageKey, {});
    setName(persisted.name ?? displayName);
    setCategoryValue(persisted.category ?? category);
    setSkillsValue(persisted.skills ? persisted.skills.join(', ') : skills.join(', '));
    setAvailabilityValue(persisted.availability ?? availability);
    setNotes(persisted.notes ?? '');
    setValidationError('');
    setSaveState('idle');
  };

  const markDirty = () => {
    if (saveState !== 'idle') setSaveState('idle');
    if (validationError) setValidationError('');
  };

  return (
    <section className="profile-editor" aria-label="Prototype profile editor">
      <div className="eyebrow eyebrow-dark">PROFILE EDITOR · LOCAL PROTOTYPE</div>
      <p className="form-note">
        Changes are stored in this browser only (localStorage) and survive refresh. No account or
        backend is involved. When storage is unavailable, edits are kept in memory for the session.
      </p>
      <label>
        <span>Display name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            markDirty();
          }}
        />
      </label>
      <label>
        <span>Service category</span>
        <select
          value={categoryValue}
          onChange={(e) => {
            setCategoryValue(e.target.value as TechnicianCategory);
            markDirty();
          }}
        >
          {technicianCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Skills (comma separated)</span>
        <input
          value={skillsValue}
          onChange={(e) => {
            setSkillsValue(e.target.value);
            markDirty();
          }}
          placeholder="Example: Home wiring, Socket repair"
        />
      </label>
      <label>
        <span>Availability status</span>
        <input
          value={availabilityValue}
          onChange={(e) => {
            setAvailabilityValue(e.target.value);
            markDirty();
          }}
        />
      </label>
      <label>
        <span>Service notes</span>
        <textarea
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            markDirty();
          }}
          placeholder="Example: Same-day visits in Kitwe central..."
        />
      </label>
      {validationError && (
        <p className="profile-status profile-status-error" role="alert">
          <LuCircleAlert size={12} aria-hidden="true" /> {validationError}
        </p>
      )}
      <div className="profile-editor-actions">
        <button type="button" className="button button-coral button-small" onClick={handleSave}>
          <LuSave size={12} aria-hidden="true" /> Save profile
        </button>
        <button type="button" className="outline-button" onClick={handleCancel}>
          <LuX size={12} aria-hidden="true" /> Cancel
        </button>
        {saveState === 'saved' && (
          <span className="profile-status profile-status-saved">
            <LuCircleCheck size={12} aria-hidden="true" /> Saved locally. Refresh the page to
            confirm it survives.
          </span>
        )}
        {saveState === 'quota' && (
          <span className="profile-status profile-status-error">
            <LuCircleAlert size={12} aria-hidden="true" /> Browser storage quota exceeded. Your edit
            is kept in memory for this session only.
          </span>
        )}
        {saveState === 'failed' && (
          <span className="profile-status profile-status-error">
            <LuCircleAlert size={12} aria-hidden="true" /> Could not save locally. Your edit is kept
            in memory for this session only.
          </span>
        )}
      </div>
    </section>
  );
}
