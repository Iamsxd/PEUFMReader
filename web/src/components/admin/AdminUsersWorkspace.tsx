import { UserManagement } from '../UserManagement'

interface Props {
  currentUserID: number
  onError: (message: string) => void
  onNotice: (message: string) => void
}

export default function AdminUsersWorkspace(props: Props) {
  return <UserManagement {...props} />
}
