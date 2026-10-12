import { redirect } from 'next/navigation';

/**
 * Retires the former name-addressed prototype profile route. Names are not
 * stable identifiers and this route previously exposed browser-only mock
 * records. Real profiles use /technicians/profile/:id.
 */
export default function RetiredPrototypeProfile() {
  redirect('/matching');
}
